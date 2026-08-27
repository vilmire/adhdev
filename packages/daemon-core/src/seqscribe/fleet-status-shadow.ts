/**
 * Phase 4 Stage 1 — `fleet.status` producer shadow.
 *
 * The daemon already computes a status payload every reporting tick and hands a
 * projected copy to the cloud over WS. This leg appends a SECOND, separately
 * projected copy into the `fleet.status` ring topic so peers in the fleet can
 * read a live tail directly, without the cloud in the path.
 *
 * ── This is ADDITIVE. The WS leg is not a fallback and does not move ────────
 * ★ `status/reporter.ts` (the `status_report` send, around its "Server transmit"
 * block) MUST NOT be modified, narrowed or made conditional by this stage. It
 * is tempting to read the WS path as a P2P-down fallback that the ring now
 * obsoletes; it is not. The server consumes `status_report` on a live, always-on
 * routing path — session routing, compact status, `initial_state` bootstrap and
 * push-notification gating all hang off it (packages/server/src/durable-objects/
 * daemon-status.ts). Stopping it would break push and routing for every user,
 * whether or not any peer is reading the ring.
 *
 * So the shadow appends from its OWN call site alongside the existing send, and
 * the design document's "발행부가 ring append로 전환" line has been corrected to
 * say 병행 기록 accordingly (docs/design/2026-08-26-seqscribe-integration-plan.md
 * §5). Retiring the legacy write is a later stage's decision, not this one's.
 *
 * ── The one invariant, inherited from the mesh leg ──────────────────────────
 * ★ A shadow failure must NEVER disturb status reporting. Status is load-bearing
 * for routing and push; ring replication is not. So, exactly as
 * `mesh-dual-write.ts`:
 *
 *   · SYNCHRONOUSLY NON-THROWING — `recordFleetStatusShadow` catches everything
 *     and returns a boolean. The caller needs no `try`.
 *   · ASYNCHRONOUS — `append` does real I/O (a SQLite write plus peer fan-out).
 *     Awaiting it inside the reporting tick would put replication latency on the
 *     status hot path. We fire and forget, with a rejection handler attached so
 *     a failed append can never surface as an unhandled rejection.
 *   · BOUNDED — `MAX_INFLIGHT` sheds load rather than accumulating if the topic
 *     stops draining, and the drops are counted rather than silent.
 *
 * ── No new interval, no new message ────────────────────────────────────────
 * This module defines no timer. It is called from the existing reporting tick,
 * so the ring's write rate is exactly the status report rate — which is already
 * throttled and deduped upstream. A ring of FLEET_STATUS_RING entries therefore
 * holds a bounded, self-expiring tail with no scheduling of its own.
 *
 * ── Why the topic is not defined lazily here ────────────────────────────────
 * Unlike `mesh.<id>.events`, `fleet.status` is a fixed name known at boot and is
 * already in `baseTopicDefinitions` (topics.ts), so every node that opens has
 * it. `ensureTopic` below therefore only ADOPTS — it never calls `defineTopic`,
 * and a node somehow lacking the topic disables the leg for that node rather
 * than racing the boot definition. That also means this module needs no part in
 * the P14/P15 runtime-activation choreography: a boot-time topic is already in
 * the grant map every transport builds at construction.
 */

import { estimateEntryBytes, resolveConstants, sanitizeJson, type JsonValue } from 'seqscribe';
import { LOG } from '../logging/logger.js';
import type { SeqscribeNodeHandle } from './node.js';
import { FLEET_STATUS_TOPIC } from './topics.js';
import type { FleetStatusEntry } from '../status/reporter.js';

/** Env flag name. Mirrors ADHDEV_SEQSCRIBE_MESH's role for this leg. */
export const FLEET_STATUS_ENV = 'ADHDEV_SEQSCRIBE_FLEET_STATUS';

/** Entry kind stamped on every appended record. */
export const FLEET_STATUS_ENTRY_KIND = 'adhdev.fleet.status';

export type FleetStatusMode = 'shadow' | 'off';

/**
 * Cap on appends in flight before we start dropping.
 *
 * Much smaller than the mesh leg's 512 because the write rate is bounded by the
 * status tick (order of one per second across all reasons, not per event) and
 * the topic is a 50-entry ring. If more than this many are in flight the topic
 * has genuinely stopped draining, and the useful thing to keep is the NEWEST
 * status, which the next tick supplies anyway.
 */
export const MAX_INFLIGHT = 32;

/**
 * Resolve the mode.
 *
 * ★ Note the asymmetry against `resolveMeshDualWriteMode`, which defaults ON.
 * This leg defaults to **off**: the mesh leg replaced an existing replication
 * story and its shadow is the thing that proves parity, whereas `fleet.status`
 * has no consumer yet (Stage 2 adds the dashboard SUB). Shipping a write leg
 * that is on by default before anything reads it would spend ring writes, disk
 * and peer fan-out on records nobody consumes, and would make this stage's
 * blast radius nonzero on every daemon in the fleet the moment it lands.
 *
 * An unrecognized value is treated as `off` for the same reason — fail-closed
 * is correct when the feature is opt-in — and is logged once so a typo is
 * visible rather than being silently indistinguishable from an intentional
 * omission.
 */
export function resolveFleetStatusMode(env: NodeJS.ProcessEnv = process.env): FleetStatusMode {
    const raw = env[FLEET_STATUS_ENV]?.trim().toLowerCase();
    if (!raw) return 'off';
    if (raw === 'off') return 'off';
    if (raw === 'shadow') return 'shadow';
    warnOnce(
        `unrecognized ${FLEET_STATUS_ENV}=${raw}; treating as 'off'. ` +
            "Valid values are 'shadow' and 'off' (default).",
    );
    return 'off';
}

/** Counters, surfaced for diagnostics and any later stats bucket. */
export interface FleetStatusCounters {
    /** Records successfully appended to the ring. */
    written: number;
    /** Appends that threw or rejected. */
    failed: number;
    /** Records skipped because the in-flight cap was reached. */
    dropped: number;
    /**
     * Records skipped because the estimated entry exceeded MAX_ENTRY_BYTES.
     * Expected to stay at zero — the entry is a fixed key set of scalars, so a
     * nonzero value means the SHAPE grew, which is a producer bug rather than a
     * transport condition.
     */
    oversized: number;
}

const counters: FleetStatusCounters = {
    written: 0,
    failed: 0,
    dropped: 0,
    oversized: 0,
};

let activeNode: SeqscribeNodeHandle | null = null;
let activeMode: FleetStatusMode = 'off';
let inflight = 0;
/** Tri-state: unknown (null) until the first write checks the node. */
let topicUsable: boolean | null = null;

const warnedOnce = new Set<string>();
function warnOnce(message: string): void {
    if (warnedOnce.has(message)) return;
    warnedOnce.add(message);
    LOG.warn('Seqscribe', message);
}

/**
 * Wire the shadow to a node. Passing `null` detaches (shutdown, or a node that
 * failed to open), after which every entry point is an immediate return.
 */
export function configureFleetStatusShadow(
    node: SeqscribeNodeHandle | null,
    env: NodeJS.ProcessEnv = process.env,
): void {
    activeNode = node;
    activeMode = resolveFleetStatusMode(env);
    topicUsable = null;
    inflight = 0;
    if (node && activeMode === 'shadow') {
        LOG.info('Seqscribe', `fleet.status shadow armed writer=${node.writerId}`);
    }
}

/**
 * Confirm the node carries `fleet.status`, caching the answer.
 *
 * Adoption only — see the header. A node without the topic is a node whose boot
 * definition did not run (provisional mode, or a caller that built its own
 * definition list), and defining it late here would create a topic the local
 * transport never granted; a disabled leg is the honest outcome.
 */
function ensureTopic(node: SeqscribeNodeHandle): boolean {
    if (topicUsable !== null) return topicUsable;
    const present = node.topics.some((d) => d.topic === FLEET_STATUS_TOPIC);
    topicUsable = present;
    if (!present) {
        LOG.warn(
            'Seqscribe',
            `fleet.status shadow disabled — topic ${FLEET_STATUS_TOPIC} is not defined on this node`,
        );
    }
    return present;
}

/**
 * Append one status entry to the ring.
 *
 * ★ NEVER THROWS and never blocks. Returns true when the append was handed to
 * the topic (the append itself remains asynchronous), false for every skip:
 * leg disabled, no node, topic missing, load shed, oversized, or a synchronous
 * failure. A `false` is always counted or explained by an earlier log — it is
 * never a silent drop.
 *
 * The entry arrives already projected. `fleetStatusEntry()` (status/reporter.ts)
 * is the allow-list for this topic, exactly as `projectMeshLedgerEntry` is for
 * `mesh.<id>.events`, and it is where the fixed key set is enforced. This
 * function deliberately does NOT re-shape the entry: two projections that could
 * drift is worse than one that is tested.
 */
export function recordFleetStatusShadow(entry: FleetStatusEntry): boolean {
    try {
        const node = activeNode;
        if (!node || activeMode === 'off') return false;
        if (!ensureTopic(node)) return false;

        if (inflight >= MAX_INFLIGHT) {
            counters.dropped++;
            warnOnce(
                `fleet.status shadow shedding load — ${MAX_INFLIGHT} appends in flight; ` +
                    'status records are being dropped from the RING only (the WS status_report is unaffected)',
            );
            return false;
        }

        // `sanitizeJson` rather than a cast: the entry crosses a package
        // boundary as a plain object and the library requires a JsonValue. A
        // cast would let an `undefined`, a Date or a cycle through to the
        // encoder and surface as an opaque append rejection.
        const payload: JsonValue = sanitizeJson(entry);

        // Size pre-flight before spending an in-flight slot, so a shape that
        // outgrew the ceiling is counted as `oversized` (a producer bug) rather
        // than as a generic transport `failed`.
        const estimated = estimateEntryBytes({
            topic: FLEET_STATUS_TOPIC,
            kind: FLEET_STATUS_ENTRY_KIND,
            payload,
        });
        const ceiling = resolveConstants().MAX_ENTRY_BYTES;
        if (estimated > ceiling) {
            counters.oversized++;
            warnOnce(
                `fleet.status shadow skipped an oversized record (further occurrences logged once): ` +
                    `estimated=${estimated}B ceiling=${ceiling}B. The entry is a fixed set of scalars — ` +
                    'this is a producer-shape bug, not a transport one.',
            );
            return false;
        }

        inflight++;
        void node.node
            .log(FLEET_STATUS_TOPIC)
            .append(FLEET_STATUS_ENTRY_KIND, payload)
            .then(
                () => {
                    inflight--;
                    counters.written++;
                },
                (error: unknown) => {
                    inflight--;
                    counters.failed++;
                    warnOnce(
                        `fleet.status shadow append failed (further failures logged once): ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    );
                },
            );
        return true;
    } catch (error) {
        // Synchronous throw from the sanitize/estimate path, or a static API
        // misuse the library keeps synchronous. Runtime append failures reject
        // and are handled above.
        counters.failed++;
        warnOnce(
            `fleet.status shadow threw synchronously (further throws logged once): ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        return false;
    }
}

/** Snapshot of the counters. */
export function fleetStatusCounters(): FleetStatusCounters {
    return { ...counters };
}

/** True when the leg is armed — a node is wired and the mode writes. */
export function isFleetStatusShadowActive(): boolean {
    return activeNode !== null && activeMode === 'shadow';
}

/** The resolved mode, for diagnostics. */
export function fleetStatusMode(): FleetStatusMode {
    return activeMode;
}

/** Appends currently in flight — used by tests to await quiescence. */
export function fleetStatusInflight(): number {
    return inflight;
}

/** Reset all module state. TESTS ONLY. */
export function __resetFleetStatusShadowForTests(): void {
    activeNode = null;
    activeMode = 'off';
    topicUsable = null;
    inflight = 0;
    warnedOnce.clear();
    counters.written = 0;
    counters.failed = 0;
    counters.dropped = 0;
    counters.oversized = 0;
}
