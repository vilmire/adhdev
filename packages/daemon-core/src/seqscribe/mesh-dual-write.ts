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
 * ★ Known Stage 2 limitation, deliberately not papered over: the transport's
 * per-peer `grants` map is snapshotted at SeqscribeDataChannelRouter
 * construction (packages/daemon-cloud/.../data-channel-router.ts), so a topic
 * defined AFTER a peer attached is not granted on that existing session and
 * will not converge until the peer re-attaches. That is acceptable for a
 * shadow leg whose consumer is a LOCAL parity check — local append and local
 * read are unaffected — but it must be fixed before Stage 4 makes this topic
 * load-bearing. Recorded in the design doc's Stage 2+3 landing block.
 */

import { LOG } from '../logging/logger.js';
import type { SeqscribeNodeHandle } from './node.js';
import {
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
}

const counters: MeshDualWriteCounters = { written: 0, failed: 0, dropped: 0, topicErrors: 0 };

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
        inflight++;
        // Fire and forget with BOTH handlers attached: an unhandled rejection
        // from a shadow write must never reach the process.
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
        // Synchronous throw (a closed node, a topic torn down mid-write).
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

/** Reset all module state. TESTS ONLY. */
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
}
