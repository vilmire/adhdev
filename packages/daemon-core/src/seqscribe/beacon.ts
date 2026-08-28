/**
 * seqscribe Beacon — daemon-side transport (design §7.1 Stage D).
 *
 * The Beacon board answers one question for a node that wakes after a
 * non-overlapping online window: "is there a change I have not seen?" The
 * comparison lives entirely in `node.staleness()`; the board is dumb storage
 * (§7.1.0). That makes the whole path ADVISORY — the library's `push()` already
 * swallows transport rejections with a bare `.catch()`, so a beacon that never
 * succeeds costs a prediction and nothing else. Sync is untouched.
 *
 * That property is the reason this file has no retry, no queue and no
 * reconciliation: a lost report is superseded by the next one, and machinery to
 * protect it would be machinery protecting a value that self-heals.
 *
 * ── Why the transport is injected ──────────────────────────────────────────
 * `BeaconTransport` is a two-method interface (`put`/`get`) and the cloud daemon
 * satisfies it over the server WS bridge. daemon-core cannot reach that: the
 * WS client lives in the proprietary `packages/daemon-cloud`, and `check:boundaries`
 * keeps `seqscribe/**` producer-neutral besides. So the host supplies the two
 * callbacks and this module owns everything transport-independent — the content
 * boundary, the env gate, the counters, the arming lifecycle. OSS standalone
 * simply never injects one, and `armBeacon` returns null (§7.1.6: "transport
 * absent → not started", standalone unaffected).
 *
 * ── What this module adds over calling `node.beacon(t)` directly ───────────
 *  1. The daemon-side content projection (`projectBeaconReport`). CLAUDE.md's
 *     "Beacon vector exception" permits topic-name keys and content-free
 *     counters — nothing else. The server sanitizes too (beacon-board.ts), but
 *     the boundary rule is defence in depth at every layer that can enforce it,
 *     and this is the last one that sees the report before it leaves the machine.
 *  2. The `ADHDEV_SEQSCRIBE_BEACON` gate, so a fleet can turn the path off
 *     without a redeploy.
 *  3. Content-free counters for the daemon log (§7.1.6 observability: ids and
 *     counts, never values).
 */

import { LOG } from '../logging/logger.js';
import {
    computeBeaconDiagnostics,
    readKeyStaleAdvisory,
    type BeaconBoardSnapshot,
    type BeaconDiagnostics,
    type BeaconTopicPolicyMap,
} from './beacon-diagnostics.js';
import type { SeqscribeNodeHandle } from './node.js';
import { FLEET_STATUS_TOPIC, meshIdFromEventsTopic } from './topics.js';

/** Env flag name. Mirrors FLEET_STATUS_ENV / MESH_DUAL_WRITE_ENV in role. */
export const BEACON_ENV = 'ADHDEV_SEQSCRIBE_BEACON';

export type BeaconMode = 'on' | 'off';

/**
 * Resolve the mode.
 *
 * ★ Defaults ON, and an UNRECOGNIZED value also resolves to `on`. That is the
 * opposite of the fail-closed posture the dual-write legs use, and the
 * difference is deliberate:
 *
 *   - The dual-write/read legs are a WRITE-then-READ substitution — an
 *     unrecognized value there could silently promote a shadow leg to serving
 *     reads, so ambiguity must resolve to the safe side.
 *   - Beacon neither writes to a consumer nor serves a read. It uploads
 *     content-free counters and feeds `staleness()`, which is advisory output no
 *     code path acts on automatically. The worst case of wrongly resolving to
 *     `on` is a debounced frame on an already-open WS; the worst case of wrongly
 *     resolving to `off` is a silently dead feature that looks alive — the same
 *     failure `resolveFleetStatusMode` cites when it stopped defaulting to off.
 *
 * So the asymmetry is not an oversight: `off` is an explicit, fully respected
 * opt-out, and every other value keeps the advisory path alive and logs the typo
 * once so it stays visible rather than being masked by the fallback.
 */
export function resolveBeaconMode(env: NodeJS.ProcessEnv = process.env): BeaconMode {
    const raw = env[BEACON_ENV]?.trim().toLowerCase();
    if (!raw) return 'on';
    if (raw === 'off') return 'off';
    if (raw === 'on') return 'on';
    warnOnce(
        `unrecognized ${BEACON_ENV}=${raw}; treating as 'on'. ` +
            "Valid values are 'on' (default) and 'off'.",
    );
    return 'on';
}

let warnedUnrecognized = false;
function warnOnce(message: string): void {
    if (warnedUnrecognized) return;
    warnedUnrecognized = true;
    LOG.warn('Seqscribe', message);
}

/** Test-only: reset the once-per-process typo warning. */
export function __resetBeaconWarnOnceForTest(): void {
    warnedUnrecognized = false;
}

// ─── Content boundary ───────────────────────────────────────────────────────

/**
 * One writer's position in one topic, after projection.
 *
 * A DISCRIMINATED UNION mirroring the library's `WriterEntry`, not a bag of
 * optionals: `staleness()` reads `"retired" in w ? w.finalSeq : w.contig`, so a
 * half-populated entry would read as sequence `undefined` and poison the lag
 * arithmetic on whoever consumes the board. An entry arrives complete in one of
 * the two shapes or it is dropped — never coerced to a default.
 *
 * Shape-identical to the server's `SanitizedWriterEntry` (beacon-board.ts) on
 * purpose: the two ends enforce the same allow-list, so a legacy daemon cannot
 * land a field the server accepts and vice versa.
 */
export type ProjectedWriterEntry =
    | { contig: number; chain: string; rgen?: number }
    | { retired: true; finalSeq: number; finalChain: string; rgen: number };

export interface ProjectedBeaconReport {
    node: string;
    at: string;
    vectors: Record<string, { fgen?: number; writers: Record<string, ProjectedWriterEntry> }>;
    /** Hash-only register-key hints; values are content-free writer positions. */
    hints?: Record<string, Record<string, [string, number]>>;
}

/** 64-hex chain/state hash — `CHAIN_RE` in the library's codec. */
const CHAIN_RE = /^[0-9a-f]{64}$/;

/** `adhdev-<16 hex>` today; kept permissive but bounded and charset-fenced. */
const WRITER_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Topic names are the one identifier-bearing axis Beacon may carry (CLAUDE.md
 * "Beacon vector exception"). Bounded and charset-fenced so the key space cannot
 * be used to smuggle prose.
 */
const TOPIC_RE = /^[A-Za-z0-9._*-]{1,160}$/;

const MAX_TOPICS_PER_REPORT = 512;
const MAX_WRITERS_PER_TOPIC = 512;
const MAX_HINTS_PER_TOPIC = 512;

function finiteCount(v: unknown): number | undefined {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
}

function hash64(v: unknown): string | undefined {
    return typeof v === 'string' && CHAIN_RE.test(v) ? v : undefined;
}

function projectWriterEntry(raw: unknown): ProjectedWriterEntry | null {
    if (!raw || typeof raw !== 'object') return null;
    const v = raw as Record<string, unknown>;
    const rgen = finiteCount(v.rgen);

    if (v.retired === true) {
        const finalSeq = finiteCount(v.finalSeq);
        const finalChain = hash64(v.finalChain);
        if (finalSeq === undefined || finalChain === undefined || rgen === undefined) return null;
        return { retired: true, finalSeq, finalChain, rgen };
    }

    const contig = finiteCount(v.contig);
    const chain = hash64(v.chain);
    if (contig === undefined || chain === undefined) return null;
    return rgen === undefined ? { contig, chain } : { contig, chain, rgen };
}

/** Allow-list the P27 wire shape: topic → 64-hex key digest → [writer, seq]. */
function projectHints(raw: unknown): ProjectedBeaconReport['hints'] | undefined {
    if (!raw || typeof raw !== 'object') return undefined;

    const hints: NonNullable<ProjectedBeaconReport['hints']> = {};
    let topicCount = 0;
    for (const [topic, rawTopicHints] of Object.entries(raw as Record<string, unknown>)) {
        if (topicCount >= MAX_TOPICS_PER_REPORT) break;
        if (!TOPIC_RE.test(topic) || !rawTopicHints || typeof rawTopicHints !== 'object') continue;

        const topicHints: Record<string, [string, number]> = {};
        let hintCount = 0;
        for (const [keyHash, rawPosition] of Object.entries(rawTopicHints as Record<string, unknown>)) {
            if (hintCount >= MAX_HINTS_PER_TOPIC) break;
            if (!CHAIN_RE.test(keyHash)) continue;
            if (!Array.isArray(rawPosition) || rawPosition.length !== 2) continue;
            const writer =
                typeof rawPosition[0] === 'string' && WRITER_ID_RE.test(rawPosition[0])
                    ? rawPosition[0]
                    : undefined;
            const seq = finiteCount(rawPosition[1]);
            if (writer === undefined || seq === undefined) continue;
            topicHints[keyHash] = [writer, seq];
            hintCount++;
        }

        if (hintCount === 0) continue;
        hints[topic] = topicHints;
        topicCount++;
    }
    return topicCount > 0 ? hints : undefined;
}

/**
 * Project a report down to `{node, at, vectors, hints?}` before it leaves the machine.
 *
 * ★ ALLOW-LIST, NOT DENY-LIST. Same rule as the status path's four layers
 * (CLAUDE.md "Server content boundary"): rewriting this as a `delete` of
 * known-bad keys silently ships every field a future library version adds to
 * `BeaconReport`. Only sequence numbers, chain hashes and generation counters
 * survive — nothing payload-derived, in any form. P27 `hints` are the one
 * additive shape: only 64-hex key digests with `[writerId, seq]` values survive.
 * Plaintext register keys and malformed/arbitrary values are still dropped.
 */
export function projectBeaconReport(raw: unknown): ProjectedBeaconReport | null {
    if (!raw || typeof raw !== 'object') return null;
    const v = raw as Record<string, unknown>;

    const node = typeof v.node === 'string' && WRITER_ID_RE.test(v.node) ? v.node : null;
    if (!node) return null;

    const at =
        typeof v.at === 'string' && !Number.isNaN(Date.parse(v.at))
            ? new Date(v.at).toISOString()
            : new Date(0).toISOString();

    const vectors: ProjectedBeaconReport['vectors'] = {};
    const rawVectors = v.vectors;
    if (rawVectors && typeof rawVectors === 'object') {
        let topicCount = 0;
        for (const [topic, vec] of Object.entries(rawVectors as Record<string, unknown>)) {
            if (topicCount >= MAX_TOPICS_PER_REPORT) break;
            if (!TOPIC_RE.test(topic)) continue;
            if (!vec || typeof vec !== 'object') continue;

            const rawWriters = (vec as Record<string, unknown>).writers;
            if (!rawWriters || typeof rawWriters !== 'object') continue;

            const writers: Record<string, ProjectedWriterEntry> = {};
            let writerCount = 0;
            for (const [writerId, entry] of Object.entries(rawWriters as Record<string, unknown>)) {
                if (writerCount >= MAX_WRITERS_PER_TOPIC) break;
                if (!WRITER_ID_RE.test(writerId)) continue;
                const clean = projectWriterEntry(entry);
                if (!clean) continue;
                writers[writerId] = clean;
                writerCount++;
            }

            if (writerCount === 0) continue;
            const fgen = finiteCount((vec as Record<string, unknown>).fgen);
            vectors[topic] = fgen === undefined ? { writers } : { fgen, writers };
            topicCount++;
        }
    }

    const hints = projectHints(v.hints);
    return hints ? { node, at, vectors, hints } : { node, at, vectors };
}

/**
 * The hint-mode invariant, as an assertion rather than a comment.
 *
 * `hintKeys` is a PER-TOPIC POLICY field read by the library at push time
 * (`BeaconHub.buildHints` → `topics.get(topic).policy.hintKeys`) — it is not a
 * per-call option, so a host cannot ask for "hash mode" when it starts the
 * beacon. The only way to control it is to control what the topic table
 * declares, which makes this the enforcement point.
 *
 * Rule: a topic may declare `hintKeys: 'hash'` or omit the field. `'plain'` is
 * forbidden — plaintext register keys on the server exceed CLAUDE.md's approved
 * exception. `config.settings` is deliberately opted into hash mode; this
 * assertion keeps any future plaintext opt-in a loud boot-time failure.
 */
export function assertNoPlaintextHintTopics(
    defs: readonly { topic: string; policy: { hintKeys?: 'plain' | 'hash' } }[],
): void {
    const offenders = defs.filter((d) => d.policy.hintKeys === 'plain').map((d) => d.topic);
    if (offenders.length === 0) return;
    throw new Error(
        `seqscribe beacon: topic(s) ${offenders.join(', ')} declare hintKeys:'plain'. ` +
            "Only 'hash' (or omitting the field) is permitted — plaintext register keys on the " +
            'server exceed the approved Beacon content-boundary exception (CLAUDE.md).',
    );
}

// ─── Topic replication policy (diagnostics input) ───────────────────────────

/**
 * Project the node's live topic table into the shape `computeBeaconDiagnostics`
 * needs to decide which topics its local-vs-peer comparison is valid on.
 *
 * ★ WHY: `behind` and `soleCopy` both compare a peer's sequence against OUR
 * position in `node.vectors()`. That only means something on a `full-sync`
 * topic. A `subscribe-only` topic is granted `serve`, never `full`, so the
 * library's `mutualFull()` gate is permanently false and peer entries are never
 * applied into our log — the peer writer simply never appears in `vectors()`.
 * Comparing against it therefore reports the peer's entire lifetime as "behind"
 * and every local entry as "sole-copy", forever. See
 * `BeaconTopicReplication` in beacon-diagnostics.ts for the full account.
 *
 * Structurally typed rather than taking `TopicDefinition[]` so a test can build
 * a table inline without constructing a node.
 */
export function buildTopicPolicyMap(
    handle: {
        topics: readonly {
            topic: string;
            policy: {
                replication?: string;
                retention?: { mode?: string; size?: number };
            };
        }[];
    },
): BeaconTopicPolicyMap {
    const map: Record<string, { replicates: boolean; ringSize?: number }> = {};
    for (const def of handle.topics ?? []) {
        const ring = def.policy?.retention;
        const ringSize =
            ring?.mode === 'ring' && typeof ring.size === 'number' ? ring.size : undefined;
        map[def.topic] = {
            // Only `subscribe-only` is excluded. Anything else — including an
            // unrecognised future mode — keeps the previous behaviour, so this
            // stays a targeted exclusion rather than a silent allow-list.
            replicates: def.policy?.replication !== 'subscribe-only',
            ...(ringSize !== undefined ? { ringSize } : {}),
        };
    }
    return map;
}

// ─── Default GET scope ──────────────────────────────────────────────────────

/**
 * Default GET scope: metadata-class topics only (§7.1.2 / §7.1.4).
 *
 * Mirrors the server's `isMetadataClassTopic`. `session.*.transcript` is a
 * content-class topic; its NAME is still only a name, but the approved exception
 * makes carrying it a case-by-case call, so a caller has to ask explicitly.
 *
 * ★ Derived from the live vector map rather than a hardcoded list: mesh event
 * topics are per-mesh, so the set is only knowable at runtime.
 */
export function defaultBeaconTopicScope(vectors: Readonly<Record<string, unknown>>): string[] {
    return Object.keys(vectors).filter(
        (topic) => topic === FLEET_STATUS_TOPIC || meshIdFromEventsTopic(topic) !== null,
    );
}

// ─── Counters ───────────────────────────────────────────────────────────────

/** Content-free counters (§7.1.6: identifiers and counts, never values). */
export interface BeaconCounters {
    /** Reports handed to the host transport's `put`. */
    put: number;
    /** `put` calls that threw or rejected. */
    putFailed: number;
    /** `get` calls that returned a board. */
    get: number;
    /** `get` calls that threw or rejected. */
    getFailed: number;
    /**
     * Peer reports that remained dropped after split-retry exhausted itself,
     * summed over all invocations of `doGet`. Non-zero means `staleness()` is
     * being computed from a subset of the fleet — which under-reports lag
     * rather than asserting something false, but is worth seeing in the log
     * because it means a single topic's own writer fan-out outgrew the frame
     * budget (§7.1.2: the last-resort backstop, not the common case).
     */
    truncated: number;
    /** Reports the daemon-side projection rejected outright (never sent). */
    rejected: number;
    /**
     * Extra split-retry GETs issued beyond the first, summed over all
     * invocations of `doGet`. Zero in the common case (server never truncates
     * a small fleet's response) — non-zero is visibility into how often the
     * board outgrew one frame and needed a second round trip.
     */
    splitRetries: number;
}

function emptyCounters(): BeaconCounters {
    return {
        put: 0,
        putFailed: 0,
        get: 0,
        getFailed: 0,
        truncated: 0,
        rejected: 0,
        splitRetries: 0,
    };
}

// ─── Host transport contract ────────────────────────────────────────────────

export interface BeaconGetResponse {
    /** Peer reports, already scoped by the server to the requested topics. */
    reports: unknown[];
    /** How many peers the server dropped to fit the frame budget, if it said. */
    truncated?: number;
}

/**
 * Hard ceiling on GET round trips per `doGet()` invocation, including the
 * first (design §7.1.2, owner-approved 2026-08-28: "split-retry, capped").
 *
 * A topic-list bisection needs at most `ceil(log2(N)) + 1` calls to reach every
 * topic in isolation for N topics, and `MAX_TOPICS_PER_REPORT` bounds N at 512
 * — so 16 is generous headroom for any real fleet shape while still being a
 * hard backstop against runaway recursion if the split logic ever regresses.
 * Hitting the cap ends the round with whatever residual `truncated` remains
 * exposed, exactly like the single-topic backstop below.
 */
export const MAX_BEACON_GET_QUERIES = 16;

/**
 * What a host must supply to arm the beacon.
 *
 * Deliberately NOT seqscribe's `BeaconTransport`: the host works in wire terms
 * (a projected report to upload, a topic scope to request) and never needs the
 * library's types. `armBeacon` adapts between the two, which is also what keeps
 * the projection unskippable — there is no arrangement of these callbacks that
 * reaches the library's `put` with an unprojected report.
 */
export interface BeaconHostTransport {
    /** Upload this node's projected report. Rejection is tolerated and counted. */
    put(report: ProjectedBeaconReport): Promise<void>;
    /** Fetch the board, scoped to `topics`. Rejection is tolerated and counted. */
    get(topics: readonly string[]): Promise<BeaconGetResponse>;
}

export interface ArmBeaconOptions {
    env?: NodeJS.ProcessEnv;
    /**
     * Override the GET topic scope. Defaults to metadata-class topics present
     * in the node's own vectors plus topics this node actually defined with
     * `hintKeys:'hash'`. The latter is the reviewed content-class exception;
     * provisional nodes that did not define `config.settings` do not request it.
     */
    topicScope?: (vectors: Readonly<Record<string, unknown>>) => string[];
}

export interface BeaconHandle {
    stop(): void;
    counters(): BeaconCounters;
    /**
     * Seed the library's known-vector board from auth_ok before the ordinary
     * PUT→GET cycle completes. Inbound reports cross the same Stage D
     * allow-list projection as a normal GET; malformed/content fields cannot
     * bypass the boundary merely because the server piggybacked the response.
     */
    seedKnownBoard(seed: BeaconGetResponse): void;
    /**
     * Push a report NOW, outside the library's debounce.
     *
     * The one host-driven trigger. The cloud host calls this on each
     * authenticated epoch so a reconnect re-seeds the board immediately. The
     * library's debounce only fires after an append, which an idle daemon may
     * not make for hours.
     *
     * Rejections are swallowed and counted, exactly like the library's own push.
     */
    pushNow(): Promise<void>;
    /**
     * The consumer read (mission b60d70b8): per-peer/per-topic lag and
     * sole-copy candidates, derived from the LAST captured board.
     *
     * ★ Issues NO transport call. §7.1.2's load-bearing property is that an
     * idle fleet emits zero Beacon frames, which is what leaves the status
     * dedup floor intact — so a diagnostics read (a dashboard render, a
     * `get_status_metadata`) must be free. It reads what the beacon's own
     * push/pushNow cycle last observed and reports `boardAgeMs`/`stale` so the
     * caller can judge freshness rather than trigger a refresh.
     *
     * Returns diagnostics with `stale: true` and no peers before the first
     * successful GET — an honest "I don't know yet", never a fabricated zero.
     */
    diagnostics(): BeaconDiagnostics;
}

/**
 * Merge two split-retry halves' raw (pre-projection) reports by peer `node`.
 *
 * The two halves are topic-DISJOINT queries against the SAME fleet, so the
 * common case is no overlap at all — the split is what let each half fit. But
 * because the board is scoped to the caller's requested topics, not the whole
 * report, a peer that carries topics on both sides of the split legitimately
 * appears in both halves' results, once per side, each showing only its own
 * topic slice. Union-of-topics (not last-write-wins) would be correct beacon
 * semantics, but this function only ever sees RAW server output — merging
 * topic sub-objects here would mean re-implementing the server's own
 * sanitizer shape assumptions on unsanitized input. Simpler and just as safe:
 * treat it like any other duplicate key and keep the one with the newer `at`,
 * on the same reasoning `armBeacon`'s callers already apply to `staleness()` —
 * a report that lost half its topics reads as "unknown" for those topics, the
 * same degradation as a server-side drop, never a false negative.
 */
function mergeBeaconReportsByNode(left: unknown[], right: unknown[]): unknown[] {
    const byNode = new Map<string, unknown>();
    const unkeyed: unknown[] = [];

    const ingest = (report: unknown): void => {
        const node =
            report && typeof report === 'object' && typeof (report as { node?: unknown }).node === 'string'
                ? ((report as { node: string }).node)
                : undefined;
        if (!node) {
            unkeyed.push(report);
            return;
        }
        const existing = byNode.get(node);
        if (!existing) {
            byNode.set(node, report);
            return;
        }
        const existingAt = (existing as { at?: unknown }).at;
        const candidateAt = (report as { at?: unknown }).at;
        const existingTime = typeof existingAt === 'string' ? Date.parse(existingAt) : NaN;
        const candidateTime = typeof candidateAt === 'string' ? Date.parse(candidateAt) : NaN;
        if (!Number.isNaN(candidateTime) && (Number.isNaN(existingTime) || candidateTime > existingTime)) {
            byNode.set(node, report);
        }
    };

    for (const r of left) ingest(r);
    for (const r of right) ingest(r);
    return [...byNode.values(), ...unkeyed];
}

/**
 * Arm the beacon on an open seqscribe node.
 *
 * Returns null — a no-op, not an error — when the env gate is off. A host with
 * no transport simply does not call this (standalone), which is why there is no
 * "transport absent" branch here: absence is expressed by not arming.
 *
 * ★ NO PERIODIC TIMER IS CREATED HERE, deliberately. The library owns the
 * cadence: it pushes once on `start()` and then on a 5 s debounce after each
 * applied append (`BeaconHub.notifyApplied` → `BEACON_DEBOUNCE_MS`), going
 * completely silent when the node is idle. §7.1.2 depends on exactly that: an
 * idle fleet emits ZERO beacon frames, so the status-report dedup floor
 * (30 s × 10) is untouched and a quiet daemon does not become a chatty one.
 * A heartbeat-paced timer on top would convert an idle-silent path into a
 * periodic one and reintroduce the very failure the design avoided — so the
 * cadence question is answered by the library, and the correct host
 * contribution is nothing. The only host-driven push is `pushNow()`, which is
 * edge-triggered on reconnect, not paced.
 *
 * ── ★ARM ONCE PER NODE; RE-SEED ON RECONNECT ────────────────────────────────
 * Upstream P28 made `BeaconHub.stop()` a reusable pause: stop → start performs
 * a fresh initial push and restores append-triggered debounce. We deliberately
 * keep the host's existing node-lifetime arming, however. A WS reconnect does
 * not close the seqscribe node or replace its transport bridge, so introducing
 * a stop/start boundary there would add lifecycle state without buying a
 * stronger guarantee. `pushNow()` also has the behavior reconnect actually
 * needs: re-seed the board immediately rather than wait for the next append.
 *
 * The real-library lifecycle test pins both sides of this decision: re-arm is
 * now healthy upstream, while reconnect re-seeding remains an explicit host
 * operation. Node close is still terminal upstream; our onClose hook below only
 * stops the current handle and never attempts to start it again.
 */
export function armBeacon(
    handle: SeqscribeNodeHandle,
    transport: BeaconHostTransport,
    opts: ArmBeaconOptions = {},
): BeaconHandle | null {
    const mode = resolveBeaconMode(opts.env ?? process.env);
    if (mode === 'off') {
        LOG.info('Seqscribe', `beacon disabled (${BEACON_ENV}=off)`);
        return null;
    }

    // Fail fast if the topic table ever opts a topic into plaintext hints.
    // Cheap, and it runs on the boot path where a throw is visible.
    assertNoPlaintextHintTopics(handle.topics);

    const counters = emptyCounters();
    const scopeOf =
        opts.topicScope ??
        ((vectors: Readonly<Record<string, unknown>>): string[] => [
            ...new Set([
                ...defaultBeaconTopicScope(vectors),
                ...handle.topics
                    .filter((definition) => definition.policy.hintKeys === 'hash')
                    .map((definition) => definition.topic),
            ]),
        ]);
    let stopped = false;
    // The vector portion of the scope is derived from the LAST report we
    // projected. Hash-hint topics come from this node's live definition table,
    // so a stale reader can ask for a register key it does not hold yet.
    let lastScope: string[] = [];
    // `pushNow()` bypasses the library's private buildHints(). Preserve the last
    // library-produced, already-projected hint set so reconnect re-seeding does
    // not erase it from the server board; the next applied write refreshes it.
    let lastLocalHints: ProjectedBeaconReport['hints'];
    // The last board this beacon observed, retained purely so `diagnostics()`
    // can be a free read (see the note on BeaconHandle.diagnostics). Null until
    // the first successful GET — which `computeBeaconDiagnostics` reports as
    // `stale: true`, not as an empty-but-fresh board.
    let lastBoard: BeaconBoardSnapshot | null = null;

    /** Project, send, count. Shared by the library's push and `pushNow`. */
    const doPut = async (rawReport: unknown): Promise<void> => {
        const projected = projectBeaconReport(rawReport);
        if (!projected) {
            counters.rejected++;
            // Not a throw: the library would swallow it anyway, and a rejected
            // projection is a shape bug worth a counter, not an exception that
            // pretends the transport failed.
            LOG.warn('Seqscribe', 'beacon report failed the content projection; not sent');
            return;
        }
        lastLocalHints = projected.hints;
        lastScope = scopeOf(projected.vectors);
        try {
            await transport.put(projected);
            counters.put++;
        } catch (err) {
            counters.putFailed++;
            LOG.info(
                'Seqscribe',
                `beacon put failed (advisory, ignored): ${err instanceof Error ? err.message : String(err)}`,
            );
            throw err; // library's push() chains get() off put(); let it skip
        }
    };

    /**
     * One raw transport call. Counts `get`/`getFailed` — every call here is a
     * real round trip, whether it is the first query or a split-retry half.
     */
    const rawQuery = async (topics: readonly string[]): Promise<BeaconGetResponse> => {
        try {
            const res = await transport.get(topics);
            counters.get++;
            return res;
        } catch (err) {
            counters.getFailed++;
            LOG.info(
                'Seqscribe',
                `beacon get failed (advisory, ignored): ${err instanceof Error ? err.message : String(err)}`,
            );
            throw err;
        }
    };

    /**
     * Split-retry (design §7.1.2, owner-approved 2026-08-28): when the server
     * truncates a response, the DEFAULT recovery is to bisect the topic list
     * and re-query each half, not to accept the drop. Each half is topic-scoped
     * to the same set of nodes×writers per topic, so a truncated multi-topic
     * response is very likely to fit once split (Enterprise sizing: ~55 KiB per
     * topic against a 192 KiB server budget — see beacon-board.ts).
     *
     * Peer-drop survives as the LAST-RESORT BACKSTOP for the one case a split
     * cannot fix: a single topic whose own node×writer fan-out alone exceeds
     * the budget. That residual `truncated` is exposed as-is, exactly as
     * before this change — callers already treat non-zero `truncated` as
     * "staleness computed from a subset," never as a false negative.
     *
     * `queriesUsed` is a shared mutable counter (not a param thread) because
     * every recursive branch must observe the SAME global budget — two
     * siblings each independently capped at 16 would let the pair spend 32.
     */
    const queryWithSplitRetry = async (
        topics: readonly string[],
        queriesUsed: { count: number },
    ): Promise<{ reports: unknown[]; truncated: number }> => {
        if (queriesUsed.count >= MAX_BEACON_GET_QUERIES) {
            // Budget exhausted before we could even try this slice. Report it
            // fully truncated rather than silently returning nothing — the
            // caller's board ends up short, which is the same "unknown, not
            // wrong" degradation as a server-side drop.
            return { reports: [], truncated: topics.length };
        }

        queriesUsed.count++;
        const res = await rawQuery(topics);
        const truncated = typeof res?.truncated === 'number' ? res.truncated : 0;
        const reports = Array.isArray(res?.reports) ? res.reports : [];

        if (truncated === 0 || topics.length <= 1) {
            // Nothing to split further: either the response fit, or this is
            // the single-topic backstop case — expose whatever truncated
            // remains (§7.1.2's "consumers must defer sole-copy judgement").
            return { reports, truncated };
        }

        // Budget must cover at least the two halves we are about to issue.
        if (queriesUsed.count + 2 > MAX_BEACON_GET_QUERIES) {
            return { reports, truncated };
        }

        const mid = Math.ceil(topics.length / 2);
        const left = topics.slice(0, mid);
        const right = topics.slice(mid);
        counters.splitRetries++;

        const [leftRes, rightRes] = await Promise.all([
            queryWithSplitRetry(left, queriesUsed),
            queryWithSplitRetry(right, queriesUsed),
        ]);

        return {
            reports: mergeBeaconReportsByNode(leftRes.reports, rightRes.reports),
            truncated: leftRes.truncated + rightRes.truncated,
        };
    };

    /** Fetch, re-project, count. Returns the board for `setKnownVectors`. */
    const doGet = async (): Promise<ProjectedBeaconReport[]> => {
        const queriesUsed = { count: 0 };
        let truncated = 0;
        let reports: unknown[] = [];
        try {
            const res = await queryWithSplitRetry(lastScope, queriesUsed);
            reports = res.reports;
            truncated = res.truncated;
        } catch (err) {
            counters.getFailed++;
            LOG.info(
                'Seqscribe',
                `beacon get failed (advisory, ignored): ${err instanceof Error ? err.message : String(err)}`,
            );
            throw err;
        }

        if (truncated > 0) {
            counters.truncated += truncated;
            LOG.info(
                'Seqscribe',
                `beacon get: ${truncated} peer report(s) remained truncated after split-retry ` +
                    `(${queriesUsed.count} quer${queriesUsed.count === 1 ? 'y' : 'ies'})`,
            );
        }

        // Re-project inbound reports too. The server sanitizes, but this
        // node is what feeds them to `staleness()`, and a board seeded by an
        // older build is exactly the case defence-in-depth is for.
        const clean = reports
            .map((r) => projectBeaconReport(r))
            .filter((r): r is ProjectedBeaconReport => r !== null);
        // Retain the board for `diagnostics()`. ★ `truncated` is carried with
        // it, not discarded: it is what forces every sole-copy verdict to
        // `'unknown'` (§7.1.2.1), so dropping it here would silently convert a
        // deferred judgement into a confident wrong one.
        lastBoard = {
            reports: clean,
            truncated,
            topicScope: [...lastScope],
            capturedAt: Date.now(),
        };
        LOG.info(
            'Seqscribe',
            `beacon get writer=${handle.writerId} peers=${clean.length} topics=${lastScope.length}`,
        );
        return clean;
    };

    const libHandle = handle.node.beacon({
        async put(rawReport): Promise<void> {
            if (stopped) return;
            await doPut(rawReport);
        },
        async get(): Promise<never[]> {
            if (stopped) return [];
            // The library's BeaconReport is structurally wider (optional
            // `hints`); a projected report satisfies it.
            return (await doGet()) as never[];
        },
    });

    LOG.info('Seqscribe', `beacon armed writer=${handle.writerId}`);

    const beaconHandle: BeaconHandle = {
        stop(): void {
            if (stopped) return;
            stopped = true;
            try {
                libHandle.stop();
            } catch {
                /* already stopped by node.close() */
            }
            LOG.info(
                'Seqscribe',
                `beacon stopped writer=${handle.writerId} put=${counters.put}/${counters.put + counters.putFailed} ` +
                    `get=${counters.get}/${counters.get + counters.getFailed} splitRetries=${counters.splitRetries} ` +
                    `truncated=${counters.truncated} rejected=${counters.rejected}`,
            );
        },
        counters: () => ({ ...counters }),

        seedKnownBoard(seed: BeaconGetResponse): void {
            if (stopped || !Array.isArray(seed?.reports)) return;

            // Defence in depth: auth_ok is just another inbound transport
            // envelope. Never trust its server-side projection as sufficient.
            const clean = seed.reports
                .map((report) => projectBeaconReport(report))
                .filter((report): report is ProjectedBeaconReport => report !== null);
            const truncated =
                typeof seed.truncated === 'number' && Number.isFinite(seed.truncated) && seed.truncated >= 0
                    ? Math.floor(seed.truncated)
                    : 0;
            const topicScope = [...new Set(clean.flatMap((report) => [
                ...Object.keys(report.vectors),
                ...Object.keys(report.hints ?? {}),
            ]))];

            try {
                handle.node.setKnownVectors(clean as never[]);
                lastBoard = {
                    reports: clean,
                    truncated,
                    topicScope,
                    capturedAt: Date.now(),
                };
                if (truncated > 0) counters.truncated += truncated;
                LOG.info(
                    'Seqscribe',
                    `beacon auth seed writer=${handle.writerId} peers=${clean.length} ` +
                        `topics=${topicScope.length} truncated=${truncated}`,
                );
            } catch (err) {
                // Advisory and self-healing: the ordinary GET remains armed and
                // will replace this seed on its next successful response.
                LOG.info(
                    'Seqscribe',
                    `beacon auth seed rejected (advisory, ignored): ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        },

        async pushNow(): Promise<void> {
            if (stopped) return;
            try {
                // `node.vectors()` is the same source `BeaconHub.push()` reads.
                // P27 hint derivation is private to the library, so preserve
                // its last projected hint set rather than clearing it on the
                // server during reconnect re-seeding.
                await doPut({
                    node: handle.writerId,
                    at: new Date().toISOString(),
                    vectors: handle.node.vectors(),
                    ...(lastLocalHints ? { hints: lastLocalHints } : {}),
                });
                const board = await doGet();
                if (!stopped) handle.node.setKnownVectors(board as never[]);
            } catch {
                // Advisory: mirrors the library's own `push().catch()`. Both
                // legs already counted the failure before it got here.
            }
        },

        diagnostics(): BeaconDiagnostics {
            // `node.vectors()` is a pure getter (unlike `stats()`, which drains
            // interval counters — see throughput-collector.ts), so reading it
            // per call is free and always current.
            let localVectors: Record<string, { writers?: Record<string, unknown> }> = {};
            try {
                localVectors = handle.node.vectors() as typeof localVectors;
            } catch {
                // A closing node still deserves an honest answer about the
                // board rather than a thrown diagnostics call.
            }
            return computeBeaconDiagnostics({
                node: handle.writerId,
                localVectors,
                board: lastBoard,
                // ★ Read from the live definition table on every call, not once
                // at arm time: per-session transcript topics are defined on
                // demand (topics.ts `baseTopicDefinitions`), so a map snapshot
                // taken at boot would miss them and let a subscribe-only ring
                // back into the arithmetic.
                topicPolicy: buildTopicPolicyMap(handle),
                // ★ Advisory only (§5.7a). Query the hash keys peers actually
                // advertised; the upstream reader chooses the raw max seq
                // across writers, so this must never become a correctness gate.
                keyStaleAdvisory: readKeyStaleAdvisory(
                    handle,
                    [...new Map(
                        (lastBoard?.reports ?? [])
                            .filter((report) => report.node !== handle.writerId)
                            .flatMap((report) =>
                                Object.entries(report.hints ?? {}).flatMap(([topic, topicHints]) =>
                                    Object.keys(topicHints).map((key) => [
                                        `${topic}\0${key}`,
                                        { topic, key },
                                    ] as const),
                                ),
                            ),
                    ).values()],
                ),
            });
        },
    };

    // Tie teardown to node close as well: the node can be closed by a path that
    // never saw this handle (daemon shutdown), and an armed beacon on a closing
    // node would push against a dead core. `stop()` is idempotent, so a host
    // that also calls it explicitly is fine.
    handle.onClose(() => beaconHandle.stop());

    return beaconHandle;
}
