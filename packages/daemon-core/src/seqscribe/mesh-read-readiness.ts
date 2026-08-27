/**
 * Phase 2 Stage 4A — the per-mesh readiness gate.
 *
 * `ADHDEV_SEQSCRIBE_MESH=primary` states an INTENT: serve the allow-listed
 * reads from the replicated store. This module answers the separate, per-mesh
 * question of whether that store can actually answer correctly *right now*.
 * Both must hold; either one alone routes the read back to the ledger.
 *
 * ★ The gate is fail-closed in the direction that matters. Every unknown, every
 * error, every missing datum resolves to NOT ready, because the fallback is the
 * local ledger — the store that is authoritative by construction and cannot be
 * stale relative to itself. A false "not ready" costs nothing but the cutover;
 * a false "ready" serves a wrong answer to dispatch and suppression logic. The
 * asymmetry is total, so the gate never guesses optimistically.
 *
 * ── The four conditions ────────────────────────────────────────────────────
 *
 *  1. TOPIC + GRANT. The topic must be defined on this node AND present in the
 *     transport's grant map.
 *
 *     ★ This condition was written against a defect that has since been FIXED,
 *     and it is retained deliberately as a defence layer rather than as the
 *     mitigation. The history matters for understanding what it still buys:
 *
 *     The per-peer `grants` map used to be snapshotted in the
 *     `SeqscribeDataChannelRouter` CONSTRUCTOR and passed by value into each
 *     peer session, exchanged once in HELLO. Production opens the node with NO
 *     `meshIds`, so `mesh.<id>.events` is defined lazily on first write — after
 *     the router was constructed — and was therefore absent from the grants of
 *     every already-attached peer, replicating to nobody until re-attach.
 *
 *     seqscribe v3.5 P14/P15 closed this: `onTopicActivated`
 *     (seqscribe/mesh-dual-write.ts) announces a runtime-defined topic, and the
 *     transport re-derives its full grant map and calls
 *     `ReconnectHandle.updateGrants` on every live peer. A mesh created after
 *     boot now converges without waiting for a re-attach.
 *
 *     So why keep the condition? Because it is cheap and it fails in the safe
 *     direction. `updateGrants` is a runtime call that can be missed — a
 *     listener that threw, a peer mid-teardown, a daemon on a pre-P15 build at
 *     the other end of the session. If any of those leaves a topic ungranted,
 *     the consequence for Stage 4A is specific and bad: a consumer reading a
 *     topic no peer is feeding sees only this daemon's own writes and concludes
 *     the rest of the fleet did nothing. The gate turns that into a counted
 *     `topic_not_granted` fallback to the ledger instead of a wrong answer.
 *     See `reportMeshTopicGrants`, which the transport now calls on every grant
 *     re-derivation rather than once at construction.
 *
 *  2. NO QUARANTINE. `stats().topics[t].quarantined > 0` means the library
 *     rejected entries on a diverged chain. Reading a topic mid-divergence
 *     would serve entries whose ordering the fleet has not agreed on.
 *
 *  3. CONSUMER CAUGHT UP. The read model's cursor must have drained everything
 *     the local store held when the gate first asked. Outstanding lag means the
 *     index is missing entries that exist — precisely the "absence" a
 *     suppression consumer would misread as "this never happened".
 *
 *     ★ EVENT-DRIVEN, not polled. This condition used to read
 *     `stats().topics[t].consumers[name].lagRows === 0` on every gate
 *     evaluation. That was a poll: it re-derived the same answer on every read,
 *     and it raced a moving head — `lagRows` is `maxRowid - lastRowid`, so a
 *     write landing between the drain and the check reopens the lag and flaps
 *     the gate even though the index is not actually behind on anything it was
 *     asked about.
 *
 *     seqscribe v3.5 P19 replaced it: `consumerCaughtUp(topic, consumer)`
 *     snapshots the head AT CALL TIME and resolves once every entry through
 *     that head has completed its callback AND advanced the durable cursor.
 *     Later appends explicitly begin a new interval rather than deferring
 *     resolution — which is exactly the semantics this gate wants, because the
 *     question is "has the index absorbed the backlog", not "is the log
 *     momentarily quiet".
 *
 *     ★ WHY A LATCH: the promise is async, and this gate is synchronous on hot
 *     paths (the suppression check runs per inbound mesh event). So the gate
 *     ARMS the promise once per mesh (`isConsumerCaughtUp`) and reads a latched
 *     boolean thereafter. The latch is set on resolve, and cleared whenever the
 *     consumer identity changes underneath it — a rebuild, a detach, a node
 *     swap — because a rewound cursor invalidates the "drained" claim that the
 *     previous resolution made. Rejection (unsubscribe, node close) also clears
 *     it, leaving the mesh on the ledger, which is the safe direction.
 *
 *  4. PARITY CLEAN. Zero mismatches observed since boot. This is the condition
 *     the whole staged rollout was built to produce: Stage 3 exists so that the
 *     cutover has evidence rather than optimism. A mismatch means the projection
 *     and the ledger disagree somewhere, and until that is understood the
 *     replicated store does not get to answer questions.
 *
 * ── What this gate deliberately does NOT check ─────────────────────────────
 * Peer count and peer readiness. A mesh whose peers are all offline still has a
 * correct local replica of its own writes, and the mesh consumers switched in
 * Stage 4A ask about work this daemon itself dispatched. Requiring live peers
 * would make the cutover flap with ordinary connectivity, which is a worse
 * failure mode than a stale-but-correct answer. Condition 1 already covers the
 * case where replication is structurally impossible.
 */

import { LOG } from '../logging/logger.js';
import { isMeshReadPrimary } from './mesh-dual-write.js';
import { meshParityCounters } from './mesh-parity.js';
import {
    hasMeshReadModelIndex,
    meshReadModelConsumerName,
    meshReadModelNode,
    meshReadModelRebuildEpoch,
    primeMeshReadModel,
} from './mesh-read-model.js';
import { meshEventsTopic } from './topics.js';

/** Why a mesh is not serving reads from the replica. */
export type MeshReadFallbackReason =
    | 'mode_not_primary'
    | 'no_node'
    | 'topic_undefined'
    | 'topic_not_granted'
    | 'index_missing'
    | 'quarantined'
    | 'consumer_lag'
    | 'consumer_missing'
    | 'parity_mismatch'
    | 'stats_error';

export interface MeshReadReadiness {
    ready: boolean;
    /** Null when ready; otherwise the first condition that failed. */
    reason: MeshReadFallbackReason | null;
}

/**
 * Topics the transport has actually granted to peers.
 *
 * Populated by the cloud daemon, which owns the router and is the only place
 * that knows the snapshot's contents. `null` means "no transport has reported"
 * — see `resolveGrantState` for why that is treated as permissive rather than
 * as a failure.
 */
let grantedTopics: ReadonlySet<string> | null = null;

/**
 * Report the topic set the transport snapshotted into its per-peer grants.
 *
 * Called by the daemon-cloud router at construction. Passing a set makes
 * condition 1 enforceable; never calling it leaves the gate unable to
 * distinguish "not granted" from "no transport exists".
 */
export function reportMeshTopicGrants(topics: Iterable<string> | null): void {
    grantedTopics = topics ? new Set(topics) : null;
}

/**
 * Grant state for a topic.
 *
 * ★ A daemon with no P2P transport at all (standalone, or cloud before the
 * first peer) never reports grants. Treating that as `topic_not_granted` would
 * disable the cutover permanently in standalone mode, where there are no peers
 * to converge with and the local replica is trivially complete. So an
 * unreported grant map is permissive, and only a REPORTED map that omits the
 * topic is a refusal — that is the case that means "a transport exists and this
 * topic is not on it", which is exactly the snapshot defect.
 */
function isTopicGranted(topic: string): boolean {
    if (grantedTopics === null) return true;
    return grantedTopics.has(topic);
}

/**
 * Per-mesh catch-up latch (condition 3) — see the header's EVENT-DRIVEN note.
 *
 * `armed` is the identity the outstanding `consumerCaughtUp` promise was taken
 * against: the node handle plus the consumer name. A resolution only counts if
 * that identity is still current when it lands, which is what makes a rebuild
 * (cursor rewound) or a detach (different node) invalidate an in-flight watch
 * rather than let it latch a stale "drained" claim.
 */
interface CaughtUpLatch {
    node: unknown;
    consumerName: string;
    /** The rebuild epoch this watch was taken at — see `meshReadModelRebuildEpoch`. */
    epoch: number;
    caughtUp: boolean;
    pending: boolean;
}
const caughtUpLatches = new Map<string, CaughtUpLatch>();

/**
 * Ensure a catch-up watch exists for this mesh, and report whether it has
 * resolved. Synchronous by construction — it never awaits, it only arms.
 *
 * Returns false while the watch is in flight, which routes the mesh to the
 * ledger until the index has genuinely absorbed the backlog.
 */
function isConsumerCaughtUp(
    node: { node: { consumerCaughtUp(topic: string, consumer: string): Promise<unknown> } },
    topic: string,
    meshId: string,
    consumerName: string,
): boolean {
    const epoch = meshReadModelRebuildEpoch(meshId);
    const existing = caughtUpLatches.get(meshId);
    // ★ Identity check, not mere presence. A rebuild rewinds the cursor under
    // the SAME consumer name — the epoch is what makes that visible; a detach
    // swaps the node. Either invalidates a previous resolution, so the latch is
    // rearmed rather than trusted.
    if (
        existing &&
        existing.node === node &&
        existing.consumerName === consumerName &&
        existing.epoch === epoch
    ) {
        if (existing.caughtUp || existing.pending) return existing.caughtUp;
    }

    const latch: CaughtUpLatch = { node, consumerName, epoch, caughtUp: false, pending: true };
    caughtUpLatches.set(meshId, latch);

    try {
        void node.node.consumerCaughtUp(topic, consumerName).then(
            () => {
                // Only latch if this watch is still the current one.
                if (caughtUpLatches.get(meshId) !== latch) return;
                latch.pending = false;
                latch.caughtUp = true;
            },
            (error: unknown) => {
                // unsubscribe / node close / unregistered consumer. Stay not
                // ready and let the next evaluation rearm — the fallback is the
                // ledger, so a lost watch costs the cutover and nothing else.
                if (caughtUpLatches.get(meshId) !== latch) return;
                latch.pending = false;
                latch.caughtUp = false;
                LOG.info(
                    'Seqscribe',
                    `read model catch-up watch ended mesh=${meshId}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            },
        );
    } catch (error) {
        // consumerCaughtUp rejects rather than throws (P11 discipline), but a
        // pre-P19 node would not have the method at all.
        latch.pending = false;
        LOG.warn(
            'Seqscribe',
            `read model catch-up unavailable mesh=${meshId}: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }

    return latch.caughtUp;
}

/** Per-mesh fallback counters, so a silent degrade is visible. */
const fallbackCounts = new Map<MeshReadFallbackReason, number>();
let readsServedFromReplica = 0;
let readsServedFromLedger = 0;

function countFallback(reason: MeshReadFallbackReason): void {
    fallbackCounts.set(reason, (fallbackCounts.get(reason) ?? 0) + 1);
    readsServedFromLedger++;
}

const loggedTransitions = new Map<string, string>();

/**
 * Log a mesh's readiness only when it CHANGES.
 *
 * A per-read log line would print on every suppression check — thousands per
 * hour on a busy mesh. The transition is the event worth reading.
 */
function logTransition(meshId: string, state: string): void {
    if (loggedTransitions.get(meshId) === state) return;
    loggedTransitions.set(meshId, state);
    LOG.info('Seqscribe', `mesh read path mesh=${meshId} → ${state}`);
}

/**
 * Evaluate the gate for one mesh.
 *
 * Never throws: a readiness check that failed is a fallback, and a fallback is
 * always safe. Callers use `isMeshReadModelReady` rather than this directly
 * unless they want the reason.
 */
export function evaluateMeshReadReadiness(meshId: string): MeshReadReadiness {
    if (!isMeshReadPrimary()) return { ready: false, reason: 'mode_not_primary' };

    const node = meshReadModelNode();
    if (!node) return { ready: false, reason: 'no_node' };

    const topic = meshEventsTopic(meshId);
    if (!node.topics.some((d) => d.topic === topic)) {
        return { ready: false, reason: 'topic_undefined' };
    }
    if (!isTopicGranted(topic)) {
        return { ready: false, reason: 'topic_not_granted' };
    }

    // Register the consumer if this is the first look at the mesh. Without a
    // registered consumer there is no cursor row and lag is unknowable.
    if (!hasMeshReadModelIndex(meshId)) {
        primeMeshReadModel(meshId);
        if (!hasMeshReadModelIndex(meshId)) return { ready: false, reason: 'index_missing' };
    }

    let topicStats: { quarantined: number };
    try {
        const stats = node.node.stats();
        const entry = stats.topics[topic];
        if (!entry) return { ready: false, reason: 'topic_undefined' };
        topicStats = entry;
    } catch (error) {
        LOG.warn(
            'Seqscribe',
            `read readiness stats failed mesh=${meshId}: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        return { ready: false, reason: 'stats_error' };
    }

    if (topicStats.quarantined > 0) return { ready: false, reason: 'quarantined' };

    // ★ The name the index actually registered under, not the base constant.
    // Since P17 that IS the stable constant on every rebuild, but the index
    // remains the authority on what it registered — reading the constant
    // directly would report readiness for a consumer that may not exist.
    const consumerName = meshReadModelConsumerName(meshId);
    if (!consumerName) return { ready: false, reason: 'consumer_missing' };
    // Event-driven catch-up (P19) — see the header. Not a poll: this arms one
    // promise per (mesh, node, consumer) and reads its latched result.
    if (!isConsumerCaughtUp(node, topic, meshId, consumerName)) {
        return { ready: false, reason: 'consumer_lag' };
    }

    // ★ The Stage 3 evidence condition. Any mismatch since boot blocks the
    // cutover for every mesh — parity counters are process-wide, and a
    // projection bug is not plausibly confined to one mesh.
    if (meshParityCounters().mismatches > 0) return { ready: false, reason: 'parity_mismatch' };

    return { ready: true, reason: null };
}

/**
 * The question a switched consumer asks.
 *
 * True ⇒ read from the replica. False ⇒ read the ledger, exactly as before.
 * The fallback is counted and the transition logged, so a mesh that quietly
 * stops cutting over is visible rather than silent.
 */
export function isMeshReadModelReady(meshId: string): boolean {
    const { ready, reason } = evaluateMeshReadReadiness(meshId);
    if (ready) {
        readsServedFromReplica++;
        logTransition(meshId, 'replica');
        return true;
    }
    countFallback(reason ?? 'stats_error');
    // `mode_not_primary` is the default state of every daemon that has not opted
    // in; logging a transition for it would print on every mesh at boot.
    if (reason !== 'mode_not_primary') logTransition(meshId, `ledger (${reason})`);
    return false;
}

/** Aggregate counters, for diagnostics and the stats bucket. Integers only. */
export interface MeshReadRoutingCounters {
    fromReplica: number;
    fromLedger: number;
    fallbacks: Record<string, number>;
}

export function meshReadRoutingCounters(): MeshReadRoutingCounters {
    return {
        fromReplica: readsServedFromReplica,
        fromLedger: readsServedFromLedger,
        fallbacks: Object.fromEntries(fallbackCounts),
    };
}

/** Reset module state. TESTS ONLY. */
export function __resetMeshReadReadinessForTests(): void {
    grantedTopics = null;
    fallbackCounts.clear();
    readsServedFromReplica = 0;
    readsServedFromLedger = 0;
    loggedTransitions.clear();
    caughtUpLatches.clear();
}
