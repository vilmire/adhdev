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
 * ── Off means off, and primary is a SUPERSET of shadow ─────────────────────
 * `ADHDEV_SEQSCRIBE_MESH` (design §3): `primary` (★ the default since the Phase
 * 2 flip) writes the shadow leg AND serves allow-listed reads from it; `shadow`
 * writes the leg without moving any read; `off` makes every entry point an
 * immediate return, so the daemon behaves byte-identically to a build without
 * this file. `shadow` and `off` are the rollback path.
 *
 * ★ Stage 4A adds `primary`, and the important property is that it does NOT
 * turn the shadow off. `primary` = shadow's writes and parity checking, PLUS a
 * read-path cutover for an allow-listed set of consumers (mesh-read-model.ts).
 * The write leg has to keep running under `primary` for two reasons: the
 * materialized read model is built by consuming the very topic the shadow
 * writes, so stopping the writes would starve the reader; and parity has to
 * keep proving the two stores agree exactly while reads are being served from
 * one of them. Stage 5 owns stopping the legacy write, not this stage.
 *
 * So `isMeshDualWriteActive()` is true for BOTH shadow and primary — every
 * existing caller keeps its meaning — and the read cutover asks the separate
 * `isMeshReadPrimary()` question.
 *
 * Before Stage 4A, `primary` was deliberately rejected (it fell through to the
 * unrecognized-value branch and was treated as `shadow`) so that setting it
 * early looked like a typo rather than a cutover that never happened. That
 * trap is now resolved by accepting the value for real.
 *
 * ── Topic definition is lazy, and that has a limit ─────────────────────────
 * `openSeqscribeNode` is called with NO `meshIds` in production
 * (boot/daemon-lifecycle.ts), so per-mesh topics are not defined at node open —
 * a daemon does not know its mesh set that early. We define the events topic on
 * first write and define both events + handoff when a mesh scope is discovered,
 * which the library permits any time before close.
 *
 * ★ On-first-WRITE alone is not enough, and that was a live replication stall.
 * A node that only CONSUMES a mesh never writes, so it never defines the topic,
 * never grants it, and `mutualFull` stays false forever — which silently
 * disables every sync path for that pair. `activateKnownMeshTopics` below
 * closes this at boot for coordinator-local meshes and at runtime when a remote
 * daemon receives a mesh-scoped P2P command; see its doc-comment for the full
 * mechanism.
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
 *      events side and `ensureHandoffTopic` its content companion. A coordinator
 *      activates locally-known meshes at boot; a remote daemon activates when a
 *      P2P command/task reveals `meshId`; a writer also activates events on its
 *      first append. Discovery is what makes a peer that never writes reach
 *      step 2 at all.
 *   2. `updateGrants(fullNewMap)` on EACH side's handle — the transport's job,
 *      driven by the notification this module emits.
 *
 * Ordering between the two sides is free: the topic becomes mutual when the
 * second side updates, and the library then runs an immediate HAVE round so an
 * existing backlog converges without waiting for anti-entropy. Both endpoints
 * must run a P15 build, which the vendored-fleet bump guarantees.
 *
 * ── ★ The PROCESS boundary, and why a backfill exists ──────────────────────
 * `activeNode` above is MODULE state, so the shadow leg is armed per PROCESS,
 * not per machine. `configureMeshDualWrite` has exactly one arming caller —
 * `boot/daemon-lifecycle.ts` — which means the shadow is armed in the DAEMON
 * process and nowhere else.
 *
 * That would be complete if the daemon were the only writer. It is not. The
 * **mcp-server process** (`oss/packages/mcp-server`) imports `appendLedgerEntry`
 * from daemon-core and calls it IN ITS OWN PROCESS — mesh tools for missions,
 * graph gates/enqueue decisions, dispatch, operating notes and more, ~20 ledger
 * kinds across its tool modules. It boots no daemon lifecycle and opens no
 * seqscribe node. So in that process `activeNode` is null forever, and
 * `recordMeshEventShadow` returns at its first line.
 *
 * The result was a SILENT, STRUCTURAL divergence: those entries reached the
 * shared SQLite ledger (both processes share it) but were never mirrored, so
 * parity reported them as `missing_in_shadow` on every sweep — a permanent
 * backlog that reads like a broken replication leg while the leg is in fact
 * working perfectly for every append the daemon itself makes.
 *
 * ★ The mcp-server cannot simply arm its own leg: the seqscribe DB is
 * SINGLE-OWNER-LOCKED and the daemon holds the lock, so a second node in a
 * second process cannot open. Routing every append over IPC to the daemon is
 * the structurally clean fix, but it is ~68 call sites and a new failure mode on
 * the ledger hot path; it is recorded as future work rather than done here.
 *
 * What ships instead is a REPAIR: the daemon — the process that does hold the
 * node — mirrors the entries it finds missing, from the ledger both processes
 * share. See `backfillMeshEventShadow` below and `mesh/mesh-parity-loop.ts`.
 *
 * ★ Detection is NOT weakened to accommodate this. The parity check still
 * reports every missing entry and still increments its counters; the backfill
 * runs AFTERWARDS and is counted in its own bucket. A mismatch that survives a
 * backfill into the next sweep is therefore a REAL replication failure, cleanly
 * distinguishable from the expected cross-process gap.
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
import {
    meshEventsPolicy,
    meshEventsTopic,
    meshHandoffPolicy,
    meshHandoffTopic,
} from './topics.js';

/** Env flag name (design §3 step 1). */
export const MESH_DUAL_WRITE_ENV = 'ADHDEV_SEQSCRIBE_MESH';

export type MeshDualWriteMode = 'shadow' | 'off' | 'primary';

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
 * Resolve the mode. The three values are explicit; anything else is `shadow`.
 *
 * ── ★ Phase 2 default flip: ABSENT now means `primary` ─────────────────────
 * An unset flag is the production posture of the entire fleet, so this line is
 * what actually turns the read cutover on. It is safe to default because the
 * mode is only ONE of two independent permissions: every switched read must
 * ALSO pass the per-mesh readiness gate (mesh-read-readiness.ts), which is
 * fail-closed on all four of its conditions and falls back to the ledger. The
 * mode says what the operator intends; readiness says whether this mesh's
 * replica can actually answer right now. Defaulting the intent does not weaken
 * the check.
 *
 * ★ Note the asymmetry, which is deliberate and is NOT changed by the flip. An
 * unrecognized value still falls back to `shadow` — NOT to `off` and NOT to
 * `primary`:
 *
 *   · not `off`, because the flag exists to disable a default-on write leg, and
 *     a typo must not silently stop replication.
 *   · ★ not `primary`, because `primary` moves reads onto the replicated store.
 *     Fail-closed on the READ cutover means an unparseable value keeps reads on
 *     the legacy ledger, which is the store that cannot be wrong. A typo may
 *     cost replication observability; it must never redirect reads.
 *
 * The distinction that keeps both rules coherent: ABSENT is a deployment
 * default the operator never spoke to, and it resolves to the mode this phase
 * ships. A value the operator DID write but that cannot be parsed is a stated
 * intent we failed to understand, and guessing `primary` there would move reads
 * on the strength of a typo. Explicit `shadow` and `off` remain the rollback.
 *
 * The unrecognized value is still logged once so it is visible as a typo.
 */
export function resolveMeshDualWriteMode(env: NodeJS.ProcessEnv = process.env): MeshDualWriteMode {
    const raw = env[MESH_DUAL_WRITE_ENV]?.trim().toLowerCase();
    if (!raw) return 'primary';
    if (raw === 'off') return 'off';
    if (raw === 'shadow') return 'shadow';
    if (raw === 'primary') return 'primary';
    warnOnce(
        `unrecognized ${MESH_DUAL_WRITE_ENV}=${raw}; treating as 'shadow' (reads stay on the ledger). ` +
            "Valid values are 'primary' (the default when unset), 'shadow' and 'off'.",
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
    /** Per-mesh topics that could not be defined (fatal for that topic only). */
    topicErrors: number;
    /**
     * Records mirrored LATE, by the parity loop's backfill, rather than inline
     * at `appendLedgerEntry` time (mesh/mesh-parity-loop.ts).
     *
     * ★ Counted separately from `written` ON PURPOSE, and the distinction is the
     * whole point of the counter. `written` means "the shadow leg was armed in
     * the process that made the ledger write". A record that only ever arrives
     * through `backfilled` means the ORIGINATING PROCESS had no armed shadow —
     * which today is the structural, expected condition for every ledger append
     * made by the mcp-server process (see the backfill note in the header).
     *
     * So a steady nonzero `backfilled` with a clean parity result is HEALTHY —
     * the repair is working. `backfilled` collapsing to zero while
     * `missing_in_shadow` persists is the failure signal, and folding this into
     * `written` would have erased exactly that distinction.
     */
    backfilled: number;
    /**
     * Backfill attempts that failed — the entry was still missing after the
     * mirror call, or the mirror itself could not run. Distinct from `failed`
     * (an inline append rejection) because the remedy differs: a failing
     * backfill means the repair path is broken while the inline path may be
     * fine.
     */
    backfillFailed: number;
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
    backfilled: 0,
    backfillFailed: 0,
    oversized: 0,
};

/** Topics we have already defined (or failed to define) on the current node. */
const definedTopics = new Map<string, boolean>();

/**
 * Mesh ids learned before or after the seqscribe node is armed.
 *
 * The command router can receive a mesh-scoped P2P command during the narrow
 * boot window before `configureMeshDualWrite`. Remembering the id makes runtime
 * discovery level-triggered rather than edge-triggered: arming replays the set,
 * so one early task cannot be the only discovery signal and still be lost.
 */
const discoveredMeshIds = new Set<string>();

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
 * Fires ONLY for topics defined after boot (runtime mesh events/handoff paths).
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
    if (node && activeMode === 'primary') {
        // The write leg is identical to shadow here — only the READ path differs
        // (mesh-read-model.ts), and it differs per mesh behind a readiness gate.
        LOG.info(
            'Seqscribe',
            `mesh dual-write armed in PRIMARY mode writer=${node.writerId} — ` +
                'reads cut over per mesh once the readiness gate passes',
        );
    } else if (node && activeMode === 'shadow') {
        LOG.info('Seqscribe', `mesh dual-write shadow armed writer=${node.writerId}`);
    } else if (node) {
        LOG.info('Seqscribe', `mesh dual-write disabled (${MESH_DUAL_WRITE_ENV}=off)`);
    }
    if (node && discoveredMeshIds.size > 0) {
        activateMeshTopicsNow(discoveredMeshIds);
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
 * Ensure the content-class handoff companion for a discovered mesh exists.
 *
 * This deliberately shares the events topic's P14/P15 announcement path: the
 * transport must replace grants on already-attached peers after either topic is
 * defined. An authority-less node cannot define content topics by design, so
 * it skips the handoff leg while still activating the metadata events topic.
 */
function ensureHandoffTopic(node: SeqscribeNodeHandle, meshId: string): string | null {
    if (!node.authorityEnabled) return null;

    const topic = meshHandoffTopic(meshId);
    const known = definedTopics.get(topic);
    if (known === true) return topic;
    if (known === false) return null;

    if (node.topics.some((d) => d.topic === topic)) {
        definedTopics.set(topic, true);
        return topic;
    }

    try {
        const policy = meshHandoffPolicy();
        node.node.defineTopic(topic, policy);
        node.topics.push({ topic, policy });
        definedTopics.set(topic, true);
        LOG.info('Seqscribe', `mesh handoff topic defined topic=${topic}`);
        announceTopicActivated(node, topic);
        return topic;
    } catch (error) {
        definedTopics.set(topic, false);
        counters.topicErrors++;
        LOG.warn(
            'Seqscribe',
            `handoff replication disabled for this mesh — defineTopic failed topic=${topic}: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        return null;
    }
}

function activateMeshTopicsNow(meshIds: Iterable<string>): number {
    const node = activeNode;
    if (!node) return 0;
    let activated = 0;
    for (const meshId of meshIds) {
        const eventTopic = meshEventsTopic(meshId);
        const handoffTopic = meshHandoffTopic(meshId);
        const eventWasKnown = definedTopics.has(eventTopic);
        const handoffWasKnown = definedTopics.has(handoffTopic);

        // The events leg follows ADHDEV_SEQSCRIBE_MESH's rollback switch. The
        // handoff leg is an independent feature and remains available when the
        // mesh read/write shadow is disabled, matching boot topic registration.
        if (activeMode !== 'off') ensureTopic(node, meshId);
        ensureHandoffTopic(node, meshId);

        if ((!eventWasKnown && definedTopics.get(eventTopic) === true)
            || (!handoffWasKnown && definedTopics.get(handoffTopic) === true)) {
            activated++;
        }
    }
    return activated;
}

/**
 * Define the events/handoff topic pair for meshes this daemon learns about,
 * without waiting for a local write.
 *
 * ── Why lazy-on-write is not sufficient ────────────────────────────────────
 * `mutualFull(topic)` (seqscribe session.ts) is true only when BOTH endpoints
 * grant the topic `full`, and each side derives its grant map from its OWN
 * defined topic set. Every sync path is gated on it: `processPeerVectors` skips
 * a non-mutual topic outright, `serveHave` omits it from the advertised
 * vectors, and `queueWant` is therefore never reached. Anti-entropy still fires
 * on schedule — it simply cannot see the topic.
 *
 * So "define on first write" deadlocks for a PURE CONSUMER. A node that
 * participates in a mesh but has not itself appended a mesh event never defines
 * the topic, never grants it, and never pulls the writer's backlog. The writer
 * accumulates unreplicated entries monotonically while its own logs show the
 * topic was never selected for a sync round — because from the transport's
 * point of view the topic does not exist on that pair.
 *
 * The coordinator supplies its machine-local mesh registry at boot. Remote
 * daemons cannot: `~/.adhdev/meshes.json` is not replicated there. Their common
 * command router instead calls this function when an existing P2P envelope
 * reveals `meshId` (`meshContext`, `inlineMesh`, or session settings). The id is
 * remembered if it arrives before node arming, then replayed at configure time.
 * `announceTopicActivated` drives P14/P15 grant re-advertisement, so a topic that
 * becomes mutual triggers an immediate HAVE round and the backlog converges.
 *
 * ── Cost ───────────────────────────────────────────────────────────────────
 * Bounded by the meshes this daemon is configured for or actually receives a
 * command for (a handful), and it adds no new traffic pattern: each empty topic
 * contributes one vector entry to existing HAVE rounds. It appends nothing.
 *
 * Never throws — a mesh whose topic cannot be defined is skipped and counted by
 * the existing failure cache. Authority-less nodes still activate metadata
 * events but intentionally skip content-class handoff. Returns the number of
 * mesh scopes with at least one newly activated topic (for logging and tests).
 */
export function activateKnownMeshTopics(meshIds: readonly string[]): number {
    const normalizedMeshIds: string[] = [];
    for (const meshId of meshIds) {
        if (typeof meshId !== 'string') continue;
        const normalized = meshId.trim();
        if (!normalized) continue;
        discoveredMeshIds.add(normalized);
        normalizedMeshIds.push(normalized);
    }
    return activateMeshTopicsNow(normalizedMeshIds);
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
    entry: MeshShadowEntry,
): void {
    recordMeshEvent(meshId, entry, 'inline');
}

/**
 * Ledger-entry shape the shadow leg accepts. Structural on purpose — the
 * boundary check forbids `seqscribe/** → mesh/**`, so this cannot be
 * `MeshLedgerEntry`.
 */
export interface MeshShadowEntry {
    id: string;
    timestamp: string;
    kind: string;
    nodeId?: string | undefined;
    sessionId?: string | undefined;
    providerType?: string | undefined;
    taskId?: string | undefined;
    payload?: Record<string, unknown> | undefined;
}

/**
 * Mirror a ledger entry that the inline shadow leg never saw — the REPAIR path
 * for the cross-process gap, driven by the parity loop (mesh/mesh-parity-loop.ts).
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * `activeNode` is module state set by `configureMeshDualWrite`, whose only
 * caller is `boot/daemon-lifecycle.ts` — i.e. THE DAEMON PROCESS. But
 * `appendLedgerEntry` is also called in-process by the **mcp-server process**,
 * which imports daemon-core directly and never boots a daemon lifecycle. There,
 * `activeNode` is permanently null and `recordMeshEventShadow` returns at its
 * first line: the entry lands in the shared SQLite ledger and is never mirrored.
 *
 * That is not a race and not a bug in the shadow leg — it is a process boundary.
 * The mcp-server cannot open its own node either: the seqscribe DB is
 * single-owner-locked and the daemon holds it. So the repair has to run in the
 * process that DOES hold the node, from the ledger both processes share.
 *
 * ── Why doing it from the parity loop is safe ──────────────────────────────
 * Three properties make a late mirror equivalent to an inline one:
 *
 *   · ORDER — the read model sorts by `(payload.timestamp ASC, canonical order
 *     ASC)` (mesh-read-model.ts, and the design doc's "정렬 키" note). A
 *     backfilled record carries the ORIGINAL ledger `timestamp`, so it sorts
 *     into its rightful position no matter when it was appended. Only the
 *     tie-break degrades, and only among entries sharing a millisecond.
 *   · IDEMPOTENCE — records are keyed by the ledger entry's own `id`, and both
 *     the parity comparison and the read model index by that id. Mirroring an
 *     entry that is already present overwrites with an identical projection.
 *   · PURITY — `projectMeshLedgerEntry` is a pure function of the entry, so a
 *     mirror produced now is byte-identical to one produced at append time.
 *     ★ This is also why the content boundary is unaffected: backfill goes
 *     through the SAME allow-list projection, not around it.
 *
 * Returns true when the mirror was handed to the topic (the append itself is
 * still asynchronous and fire-and-forget, exactly as inline). Never throws.
 */
export function backfillMeshEventShadow(meshId: string, entry: MeshShadowEntry): boolean {
    return recordMeshEvent(meshId, entry, 'backfill');
}

/**
 * The shared write core. `origin` selects which counter a success increments and
 * nothing else — the projection, the size pre-flight, the load-shed cap and the
 * failure handling are deliberately IDENTICAL on both paths, so a backfilled
 * record cannot differ from an inline one in any way a consumer could observe.
 */
function recordMeshEvent(
    meshId: string,
    entry: MeshShadowEntry,
    origin: 'inline' | 'backfill',
): boolean {
    try {
        const node = activeNode;
        if (!node || activeMode === 'off') return false;

        const topic = ensureTopic(node, meshId);
        if (!topic) return false;

        if (inflight >= MAX_INFLIGHT) {
            counters.dropped++;
            warnOnce(
                `mesh dual-write shedding load — ${MAX_INFLIGHT} appends in flight; ` +
                    'records are being dropped from the SHADOW leg only (the ledger is unaffected)',
            );
            return false;
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
            return false;
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
                    if (origin === 'backfill') counters.backfilled++;
                    else counters.written++;
                },
                (error: unknown) => {
                    inflight--;
                    if (origin === 'backfill') counters.backfillFailed++;
                    else counters.failed++;
                    warnOnce(
                        `mesh dual-write append failed (further failures logged once): ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    );
                },
            );
        return true;
    } catch (error) {
        // Synchronous throw from the projection/estimate path, or one of P11's
        // remaining static-API-misuse throws. NOT the append's runtime failures
        // — those reject, and are handled above.
        if (origin === 'backfill') counters.backfillFailed++;
        else counters.failed++;
        warnOnce(
            `mesh dual-write threw synchronously (further throws logged once): ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        return false;
    }
}

/** Snapshot of the shadow counters. */
export function meshDualWriteCounters(): MeshDualWriteCounters {
    return { ...counters };
}

/**
 * True when the write leg is armed — a node is wired and the mode WRITES.
 *
 * ★ True for `primary` as well as `shadow`. `primary` is a superset: it keeps
 * writing and keeps parity running, and only additionally moves an allow-listed
 * set of reads. Existing callers (the parity loop, the stats bucket) ask this
 * question to mean "is the shadow topic being written", and that answer is yes
 * in both modes — a `=== 'shadow'` test here would silently disable parity in
 * exactly the mode where parity matters most.
 */
export function isMeshDualWriteActive(): boolean {
    return activeNode !== null && (activeMode === 'shadow' || activeMode === 'primary');
}

/**
 * True when the READ cutover is enabled process-wide.
 *
 * ★ This is necessary but NOT sufficient for any individual read to be served
 * from the replicated store. Every switched consumer must also pass the
 * per-mesh readiness gate (mesh-read-model.ts `isMeshReadModelReady`), because
 * a mode flag says what the operator intends while readiness says whether this
 * particular mesh's replica can actually answer correctly right now.
 */
export function isMeshReadPrimary(): boolean {
    return activeNode !== null && activeMode === 'primary';
}

/** The resolved mode, for diagnostics and the stats bucket. */
export function meshDualWriteMode(): MeshDualWriteMode {
    return activeMode;
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
    discoveredMeshIds.clear();
    inflight = 0;
    warnedOnce.clear();
    counters.written = 0;
    counters.failed = 0;
    counters.dropped = 0;
    counters.topicErrors = 0;
    counters.backfilled = 0;
    counters.backfillFailed = 0;
    counters.oversized = 0;
}
