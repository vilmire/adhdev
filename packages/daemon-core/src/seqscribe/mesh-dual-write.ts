/**
 * Phase 2 Stage 2 — mesh ledger dual-write shadow.
 *
 * Every `appendLedgerEntry` also records a PROJECTED copy of the entry into the
 * `mesh.<id>.events` seqscribe topic. The JSONL + SQLite ledger stays exactly
 * as it is and remains the system of record; this is a shadow leg whose only
 * consumer (for now) is the Stage 3 parity checker.
 *
 * ── The one invariant ──────────────────────────────────────────────────────
 * ★ A shadow failure must NEVER break a ledger write. The ledger is load-bearing
 * for task dispatch, claim, completion and recovery; seqscribe replication is
 * not. So every path here is:
 *
 *   · SYNCHRONOUSLY NON-THROWING — `recordMeshEventShadow` catches everything
 *     and returns, so the caller's `try` is belt-and-braces, not the mechanism.
 *   · ASYNCHRONOUS — the library's `append` returns a Promise that does real
 *     I/O (a SQLite write plus peer fan-out). Awaiting it inside
 *     `appendLedgerEntry` would put replication latency on the mesh hot path,
 *     which the task brief forbids. We fire and forget, and attach a rejection
 *     handler so an append failure can never surface as an unhandled rejection
 *     (which, under a daemon that treats those as fatal, would turn a shadow
 *     failure into exactly the outage this leg must not cause).
 *   · BOUNDED — a queue cap (see MAX_INFLIGHT) drops rather than accumulating
 *     if the topic somehow stops draining. A shadow that OOMs a daemon is a
 *     worse failure than a shadow that skips records, and the skip is counted.
 *
 * ── Off means off ──────────────────────────────────────────────────────────
 * `ADHDEV_SEQSCRIBE_MESH` (design §3): `shadow` (default) writes the shadow leg;
 * `off` makes every entry point an immediate return, so the daemon behaves
 * byte-identically to a build without this file. `primary` is NOT accepted —
 * Stage 4 owns the read-path cutover, and silently accepting the value now
 * would let a config typo look like a cutover that never happened.
 *
 * ── Topic definition is lazy, and that has a limit ─────────────────────────
 * `openSeqscribeNode` is called with NO `meshIds` in production
 * (boot/daemon-lifecycle.ts), so `mesh.<id>.events` is not defined at boot —
 * a daemon does not know its mesh set that early. We therefore define the
 * topic on first write for a mesh, which the library permits any time before
 * close.
 *
 * ── Runtime topic activation: the Stage 2 limitation, now CLOSED ───────────
 * This header used to record a known gap: the transport's per-peer `grants`
 * map was snapshotted at SeqscribeDataChannelRouter construction, so a topic
 * defined AFTER a peer attached was not granted on that existing session and
 * could not converge until the peer re-attached. Local append and local read
 * were unaffected, which is why it was tolerable for a shadow leg — but it made
 * a runtime-created mesh invisible to the fleet, and would have blocked Stage 4.
 *
 * seqscribe v3.5 P14/P15 supplies the missing protocol, and `onTopicActivated`
 * below is this module's half of it. The choreography (host-guide §1.5) is:
 *
 *   1. `defineTopic(topic, policy)` on BOTH endpoints — `ensureTopic` does our
 *      side; the peer daemon runs identical code and does its own on first
 *      write for the same mesh.
 *   2. `updateGrants(fullNewMap)` on EACH side's handle — the transport's job,
 *      driven by the notification this module emits.
 *
 * Ordering between the two sides is free: the topic becomes mutual when the
 * second side updates, and the library then runs an immediate HAVE round so an
 * existing backlog converges without waiting for anti-entropy. Both endpoints
 * must run a P15 build, which the vendored-fleet bump guarantees.
 */

import { LOG } from '../logging/logger.js';
import type { SeqscribeNodeHandle } from './node.js';
import {
    estimateProjectedEntryBytes,
    maxEntryBytes,
    MESH_EVENT_ENTRY_KIND,
    projectMeshLedgerEntry,
    toJsonValue,
} from './mesh-event-projection.js';
import { meshEventsPolicy, meshEventsTopic } from './topics.js';

/** Env flag name (design §3 step 1). */
export const MESH_DUAL_WRITE_ENV = 'ADHDEV_SEQSCRIBE_MESH';

export type MeshDualWriteMode = 'shadow' | 'off';

/**
 * Cap on appends in flight before we start dropping.
 *
 * Generous relative to real mesh event rates (a busy mesh produces a handful
 * per second), so this only trips when the topic has genuinely stopped
 * draining. Drops are counted and surfaced in the stats bucket rather than
 * being silent — a silent drop would read as "parity is fine" when the shadow
 * simply stopped recording.
 */
export const MAX_INFLIGHT = 512;

/**
 * Resolve the mode. Anything other than an explicit `off` is `shadow`:
 * the flag exists to DISABLE a default-on leg, so an unrecognized value must
 * not silently disable replication. An unrecognized value is logged once so a
 * typo (`ADHDEV_SEQSCRIBE_MESH=primary`) is visible rather than mistaken for a
 * working cutover.
 */
export function resolveMeshDualWriteMode(env: NodeJS.ProcessEnv = process.env): MeshDualWriteMode {
    const raw = env[MESH_DUAL_WRITE_ENV]?.trim().toLowerCase();
    if (!raw) return 'shadow';
    if (raw === 'off') return 'off';
    if (raw === 'shadow') return 'shadow';
    warnOnce(
        `unrecognized ${MESH_DUAL_WRITE_ENV}=${raw}; treating as 'shadow'. ` +
            "Valid values are 'shadow' (default) and 'off'. Stage 4 owns 'primary'.",
    );
    return 'shadow';
}

/** Counters exposed through the stats bucket (parity.ts merges them in). */
export interface MeshDualWriteCounters {
    /** Records successfully appended to the shadow topic. */
    written: number;
    /** Appends that threw or rejected. */
    failed: number;
    /** Records skipped because the in-flight cap was reached. */
    dropped: number;
    /** Meshes whose topic could not be defined (fatal for that mesh only). */
    topicErrors: number;
    /**
     * Records skipped because the estimated entry exceeded MAX_ENTRY_BYTES
     * (seqscribe v3.5 P13). Counted separately from `failed` because the cause
     * and the remedy differ: a `failed` append is a runtime/replication
     * condition, whereas an `oversized` record means the PROJECTION let
     * something through that it should have bounded — a projection bug, not a
     * transport one. Expected to stay at zero.
     */
    oversized: number;
}

const counters: MeshDualWriteCounters = {
    written: 0,
    failed: 0,
    dropped: 0,
    topicErrors: 0,
    oversized: 0,
};

/** Topics we have already defined (or failed to define) on the current node. */
const definedTopics = new Map<string, boolean>();

/** The node the shadow writes to. Null until wired, which is the normal state
 * for a daemon whose seqscribe node failed to open — dual-write then no-ops. */
let activeNode: SeqscribeNodeHandle | null = null;
let activeMode: MeshDualWriteMode = 'shadow';
let inflight = 0;

const warnedOnce = new Set<string>();
function warnOnce(message: string): void {
    if (warnedOnce.has(message)) return;
    warnedOnce.add(message);
    LOG.warn('Seqscribe', message);
}

/**
 * Listeners notified when a topic is DEFINED AT RUNTIME on a node — step 1 of
 * the P14/P15 choreography completing, so step 2 can run.
 *
 * daemon-core cannot perform step 2 itself: the peer sessions live in the cloud
 * transport (`SeqscribeDataChannelRouter`), which is a `packages/` module that
 * daemon-core must not import (the layer boundary `check:boundaries` enforces).
 * So this is an inversion — daemon-core announces, the transport subscribes.
 *
 * ── Why the registry hangs off the NODE HANDLE, not this module ─────────────
 * The obvious shape is a module-level `Set`. It is wrong twice:
 *
 *   1. It is not per-node. A process with two open nodes (the pair in the
 *      convergence gate, and any future multi-node host) would fan every
 *      activation to every node's transport, so router A would re-advertise
 *      grants derived from node A because node B defined a topic.
 *   2. It is silently INSTANCE-scoped, not process-scoped. daemon-core is
 *      loaded both as a built bundle and — under tsx, via the `@adhdev/
 *      daemon-core` path mapping — as source. Those are two module registry
 *      entries with two separate Sets, so an announcement from one is invisible
 *      to a subscriber in the other. That failure is completely silent: no
 *      throw, no log, replication simply never converges.
 *
 * Keying on the handle the announcer and the subscriber already share removes
 * both problems by construction — there is exactly one registry per node,
 * reachable identically from either module instance.
 */
type TopicActivatedListener = (topic: string) => void;

/** Non-enumerable slot on the handle; a WeakMap keyed by handle is equivalent
 * but would itself be module-scoped, reintroducing problem (2). */
const TOPIC_LISTENERS = Symbol.for('adhdev.seqscribe.topicActivatedListeners');

type ListenerHost = { [TOPIC_LISTENERS]?: Set<TopicActivatedListener> };

function listenersFor(node: SeqscribeNodeHandle): Set<TopicActivatedListener> {
    const host = node as unknown as ListenerHost;
    let set = host[TOPIC_LISTENERS];
    if (!set) {
        set = new Set<TopicActivatedListener>();
        Object.defineProperty(node, TOPIC_LISTENERS, {
            value: set,
            enumerable: false,
            writable: false,
            configurable: true,
        });
    }
    return set;
}

/**
 * Subscribe to runtime topic activation on one node.
 *
 * The transport calls this once at construction, with the very handle it
 * replicates for, and re-derives its full grant map + calls `updateGrants` on
 * every live peer whenever it fires. Returns an unsubscribe function.
 *
 * Fires ONLY for topics defined after boot (the lazy `mesh.<id>.events` path).
 * Boot-time topics are already in the map the transport builds at construction,
 * so re-announcing them would be a no-op update per peer for no reason.
 */
export function onTopicActivated(
    node: SeqscribeNodeHandle,
    listener: TopicActivatedListener,
): () => void {
    const set = listenersFor(node);
    set.add(listener);
    return () => {
        set.delete(listener);
    };
}

/**
 * Announce a runtime-defined topic to one node's subscribers. Never throws and
 * never lets one listener's failure stop another: a transport that cannot
 * re-advertise must not break the ledger write this call is nested inside.
 */
function announceTopicActivated(node: SeqscribeNodeHandle, topic: string): void {
    for (const listener of listenersFor(node)) {
        try {
            listener(topic);
        } catch (error) {
            warnOnce(
                `topic activation listener failed (further failures logged once) topic=${topic}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}

/**
 * Wire the shadow to a node. Called once from daemon boot after the seqscribe
 * node opens; passing `null` detaches (daemon shutdown, or a node that failed
 * to open).
 */
export function configureMeshDualWrite(
    node: SeqscribeNodeHandle | null,
    env: NodeJS.ProcessEnv = process.env,
): void {
    activeNode = node;
    activeMode = resolveMeshDualWriteMode(env);
    definedTopics.clear();
    inflight = 0;
    if (node && activeMode === 'shadow') {
        LOG.info('Seqscribe', `mesh dual-write shadow armed writer=${node.writerId}`);
    } else if (node) {
        LOG.info('Seqscribe', `mesh dual-write disabled (${MESH_DUAL_WRITE_ENV}=off)`);
    }
}

/**
 * Ensure `mesh.<id>.events` exists on the node, returning the topic name or
 * null if it cannot be defined.
 *
 * The failure is cached per mesh so a permanently-unusable topic costs one log
 * line rather than one per ledger append.
 */
function ensureTopic(node: SeqscribeNodeHandle, meshId: string): string | null {
    const topic = meshEventsTopic(meshId);
    const known = definedTopics.get(topic);
    if (known === true) return topic;
    if (known === false) return null;

    // Already defined at boot (a node opened WITH meshIds — tests, and any
    // future boot path that knows its meshes) — adopt it rather than
    // redefining, which the library rejects.
    if (node.topics.some((d) => d.topic === topic)) {
        definedTopics.set(topic, true);
        return topic;
    }

    try {
        node.node.defineTopic(topic, meshEventsPolicy());
        // Keep `handle.topics` truthful: the transport builds its grants map
        // from it, and a topic missing there is invisible to any later attach.
        node.topics.push({ topic, policy: meshEventsPolicy() });
        definedTopics.set(topic, true);
        LOG.info('Seqscribe', `mesh events topic defined topic=${topic}`);
        // ── P14/P15 step 1 is done; hand step 2 to the transport ────────────
        // MUST come after the `node.topics.push` above: the listener re-derives
        // its grant map from `node.topics`, so announcing first would advertise
        // a map that still lacks this topic — and P15 grant maps are a FULL
        // replacement, so that would be a silent no-op update.
        //
        // Only this branch announces. The `known === true` early return and the
        // boot-time adoption branch above both describe topics the transport
        // already knows about.
        announceTopicActivated(node, topic);
        return topic;
    } catch (error) {
        definedTopics.set(topic, false);
        counters.topicErrors++;
        LOG.warn(
            'Seqscribe',
            `mesh dual-write disabled for this mesh — defineTopic failed topic=${topic}: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        return null;
    }
}

/**
 * Record a ledger entry into the shadow topic.
 *
 * ★ NEVER THROWS and never blocks. See the header: this is called from inside
 * `appendLedgerEntry`, whose success must not depend on replication.
 *
 * The entry is projected through the content-boundary allow-list
 * (mesh-event-projection.ts) before it goes anywhere.
 */
export function recordMeshEventShadow(
    meshId: string,
    entry: {
        id: string;
        timestamp: string;
        kind: string;
        nodeId?: string | undefined;
        sessionId?: string | undefined;
        providerType?: string | undefined;
        taskId?: string | undefined;
        payload?: Record<string, unknown> | undefined;
    },
): void {
    try {
        const node = activeNode;
        if (!node || activeMode === 'off') return;

        const topic = ensureTopic(node, meshId);
        if (!topic) return;

        if (inflight >= MAX_INFLIGHT) {
            counters.dropped++;
            warnOnce(
                `mesh dual-write shedding load — ${MAX_INFLIGHT} appends in flight; ` +
                    'records are being dropped from the SHADOW leg only (the ledger is unaffected)',
            );
            return;
        }

        const projected = projectMeshLedgerEntry(entry);

        // P13 pre-flight: know the entry is appendable BEFORE spending an
        // in-flight slot on it. A projected record that exceeds the ceiling
        // would otherwise reject asynchronously and be counted as a generic
        // append failure, hiding a projection bug behind a transport-shaped
        // counter. The estimate is a conservative upper bound (no ctx), so
        // passing it means the real append cannot fail on size.
        const estimated = estimateProjectedEntryBytes(topic, projected);
        const ceiling = maxEntryBytes();
        if (estimated > ceiling) {
            counters.oversized++;
            warnOnce(
                `mesh dual-write skipped an oversized record (further occurrences logged once): ` +
                    `estimated=${estimated}B ceiling=${ceiling}B ledgerKind=${projected.ledgerKind}. ` +
                    'The projection is supposed to bound every field — this is a projection bug, not a transport one.',
            );
            return;
        }

        inflight++;
        // ── One error path, not two (seqscribe v3.5 P11) ────────────────────
        // Every data-dependent `append` failure — closed node, unknown topic,
        // JSON encoding, sealed writer, oversized entry — now REJECTS the
        // returned Promise rather than splitting between a synchronous throw
        // and a rejection. So the rejection handler below is the single place a
        // shadow-write failure is counted; the outer try/catch no longer
        // double-counts the same condition through two branches.
        //
        // The outer try/catch is retained deliberately, and its scope is now
        // narrow and honest: it guards the SYNCHRONOUS work above (`ensureTopic`,
        // `projectMeshLedgerEntry`, the P13 estimate) plus the static-misuse
        // throws P11 explicitly keeps synchronous. It is no longer the mechanism
        // by which append failures are caught.
        void node.node
            .log(topic)
            .append(MESH_EVENT_ENTRY_KIND, toJsonValue(projected))
            .then(
                () => {
                    inflight--;
                    counters.written++;
                },
                (error: unknown) => {
                    inflight--;
                    counters.failed++;
                    warnOnce(
                        `mesh dual-write append failed (further failures logged once): ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    );
                },
            );
    } catch (error) {
        // Synchronous throw from the projection/estimate path, or one of P11's
        // remaining static-API-misuse throws. NOT the append's runtime failures
        // — those reject, and are handled above.
        counters.failed++;
        warnOnce(
            `mesh dual-write threw synchronously (further throws logged once): ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
}

/** Snapshot of the shadow counters. */
export function meshDualWriteCounters(): MeshDualWriteCounters {
    return { ...counters };
}

/** True when the shadow leg is armed (a node is wired and the mode is shadow). */
export function isMeshDualWriteActive(): boolean {
    return activeNode !== null && activeMode === 'shadow';
}

/** Appends currently in flight — used by tests to await quiescence. */
export function meshDualWriteInflight(): number {
    return inflight;
}

/**
 * Reset all module state. TESTS ONLY.
 *
 * ★ Does not touch topic-activation listeners, and cannot: they live on the
 * NODE HANDLE (see `listenersFor`), not in this module, and their lifetime is
 * owned by the subscriber — the transport subscribes at construction and
 * unsubscribes on close. A test that registers a listener unsubscribes it with
 * the returned function, exactly as the transport does.
 */
export function __resetMeshDualWriteForTests(): void {
    activeNode = null;
    activeMode = 'shadow';
    definedTopics.clear();
    inflight = 0;
    warnedOnce.clear();
    counters.written = 0;
    counters.failed = 0;
    counters.dropped = 0;
    counters.topicErrors = 0;
    counters.oversized = 0;
}
