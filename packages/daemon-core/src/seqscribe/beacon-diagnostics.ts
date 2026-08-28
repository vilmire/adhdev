/**
 * seqscribe Beacon — the CONSUMER side (design §7.1, mission b60d70b8).
 *
 * Stages C/D built the whole Beacon stack — board, transport, split-retry — and
 * then stopped: the board round-trips live in production and NOTHING reads it.
 * `staleness()` is computed by the library and thrown away, so the two features
 * §7.1.0 certifies as reachable (① wake-up lag, ③ sole-copy awareness) are
 * present in the data and absent from every surface a human looks at. This file
 * is that missing read.
 *
 * ── What it produces ───────────────────────────────────────────────────────
 * A per-peer / per-topic view of "who is ahead of me, and what might only exist
 * here", derived from three inputs that are already in memory:
 *
 *   - this node's own `vectors()`            → what I hold
 *   - the last Beacon board (peer reports)   → what they hold
 *   - `node.staleness(topic)`                → the library's own lag arithmetic
 *
 * ── ★ Two disciplines this file ENFORCES IN CODE, not in comments ──────────
 *
 *  1. **truncated > 0 ⇒ sole-copy is `'unknown'`, never `false`** (§7.1.2.1).
 *     A truncated GET means the peer list we compared against is a SUBSET of
 *     the fleet, so "no peer has this entry" is unprovable — the peer that has
 *     it may simply be one the server dropped. Reporting `false` there would be
 *     a confident wrong answer; reporting `true` would invent a data-loss scare.
 *     `'unknown'` is the only honest third value, and it is a discriminated
 *     union member rather than a nullable boolean so a consumer cannot squint
 *     at it and get a falsy read. `summarizeSoleCopy` is the single decision
 *     point; every caller goes through it.
 *
 *  2. **`keyStale` is ADVISORY-ONLY and must never gate correctness** (§5.7a).
 *     It is named `keyStaleAdvisory` for exactly that reason. P27 now supplies
 *     hash-only REGISTER-key hints, but the reader picks the raw maximum `seq`
 *     across writers rather than a total order. A caller that turns it into a
 *     write gate would therefore be enforcing a known wire-shape approximation.
 *     Advisory display is the whole contract.
 *
 * ── Why the board is cached rather than re-fetched ────────────────────────
 * A diagnostics read must not become a traffic source. §7.1.2's central
 * property is that an IDLE FLEET EMITS ZERO BEACON FRAMES — that is what keeps
 * the status-report dedup floor (30 s × 10) intact. If every dashboard render
 * or `get_status_metadata` call issued a fresh GET, opening a dashboard would
 * convert a silent daemon into a periodic transmitter and reintroduce the exact
 * failure mode the design avoided. So this module NEVER calls the transport: it
 * reads the board the beacon's own push/pushNow cycle last observed, and
 * reports `boardAgeMs` so a consumer can see for itself how fresh that is.
 *
 * ── Content boundary ───────────────────────────────────────────────────────
 * ★ Everything here is LOCAL-ONLY. It carries TOPIC NAMES and PEER WRITER IDS,
 * which is precisely the fleet-shape leak `seqscribe/stats.ts` excludes from
 * the status path. The Beacon exception (CLAUDE.md "Beacon vector exception")
 * permits topic names on the BEACON BOARD path only — it does NOT widen the
 * status path. These fields therefore reach `get_status_metadata`, the daemon
 * log, and the P2P rich payload (all local/P2P surfaces), and must never be
 * added to `buildCloudSeqscribeSummary`. That projection is a fixed-key
 * allow-list, so this is safe by construction; the regression that pins it is
 * `test/status/cloud-status-content-boundary.test.ts` plus the canary in
 * `test/seqscribe/beacon-diagnostics.test.ts`.
 */

import type { BeaconDiagnosticsSummary } from '../shared-types.js';
import type { SeqscribeNodeHandle } from './node.js';
import type { ProjectedBeaconReport } from './beacon.js';

/**
 * How long a captured board stays servable to diagnostics readers.
 *
 * NOT a refresh interval — nothing here re-fetches. It is the age past which a
 * board is reported as `stale: true` so a consumer can discount it, which
 * matters because the beacon only pushes after an append: a genuinely idle
 * daemon's board is SUPPOSED to age, and that must read as "quiet", not as
 * "broken". 30 s matches the design's debounce-scale cadence (5 s push
 * debounce) with generous headroom.
 */
export const BEACON_BOARD_TTL_MS = 30_000;

/**
 * Sole-copy verdict for one (topic, writer) position.
 *
 * ★ A three-valued discriminated union, deliberately not `boolean | null`.
 * `'unknown'` is a first-class answer — §7.1.2.1 requires judgement to be
 * DEFERRED when the peer list was truncated, and a nullable boolean invites
 * `if (!soleCopy)` to silently collapse "unknown" into "no".
 */
export type SoleCopyVerdict = 'sole-copy' | 'replicated' | 'unknown';

/** Why a sole-copy verdict came out `'unknown'`. Display/debug only. */
export type SoleCopyUnknownReason = 'truncated' | 'no-board';

/** One peer's position relative to this node, for one topic. */
export interface BeaconPeerTopicLag {
    /** Peer's beacon node id (= its seqscribe writerId). */
    node: string;
    /** Topic this lag was measured on. Local-only — see the header. */
    topic: string;
    /**
     * How far ahead the peer is, in entries, summed across writers on this
     * topic. Zero means caught up (or ahead only on writers we also hold).
     */
    behind: number;
}

/** Per-peer rollup across all topics in scope. */
export interface BeaconPeerDiagnostics {
    node: string;
    /** Max `behind` across this peer's topics — the headline "am I behind" number. */
    behind: number;
    /** Per-topic detail, only for topics where `behind > 0`. */
    topics: BeaconPeerTopicLag[];
    /** The peer's own report timestamp (`at`), ISO-8601. */
    lastSeen: string;
    /** Age of `lastSeen` at read time, in ms. Negative clock skew is clamped to 0. */
    lastSeenAgeMs: number;
}

/** One position this node may be the only holder of. */
export interface BeaconSoleCopyCandidate {
    /** Topic the position lives on. Local-only — see the header. */
    topic: string;
    /** The writer whose entries may be unreplicated. Usually this node's own. */
    writer: string;
    /** This node's contiguous sequence for that writer. */
    localSeq: number;
    /**
     * The furthest any peer has confirmed for the same writer, or `null` when no
     * peer reported the topic at all.
     */
    bestPeerSeq: number | null;
    /** Entries this node holds that no peer confirmed. Only meaningful when the verdict is `'sole-copy'`. */
    unreplicated: number;
    /** ★ Deferred to `'unknown'` whenever the board was truncated (§7.1.2.1). */
    verdict: SoleCopyVerdict;
    /** Present only when `verdict === 'unknown'`. */
    unknownReason?: SoleCopyUnknownReason;
}

/**
 * The advisory pre-write hint (§5.7a / upstream P27).
 *
 * ★ Named `…Advisory` on purpose: this must never become a correctness gate.
 * The key is a 64-hex digest, never the authored register key. The library's
 * reader selects the raw maximum sequence across writers (§5.7a), so the field
 * remains advisory and the name keeps that constraint visible at every use site.
 */
export interface BeaconKeyStaleAdvisory {
    topic: string;
    key: string;
    /** Latest known entry id for the key, as reported by a peer. */
    latestKnown: unknown;
    /** Whether this node already holds that entry. */
    haveLocally: boolean;
}

/** The full local diagnostics read. */
export interface BeaconDiagnostics {
    /** This node's beacon id (= its writerId). */
    node: string;
    /** Peers seen on the last board, worst-lag first. Excludes this node. */
    peers: BeaconPeerDiagnostics[];
    /** Max `behind` across all peers and topics — the single headline number. */
    maxBehind: number;
    /**
     * Positions this node may hold alone.
     *
     * ★ Includes `'unknown'` verdicts rather than filtering them out: a
     * consumer that only ever sees confident answers cannot distinguish
     * "verified replicated" from "we could not tell", which is the distinction
     * §7.1.2.1 exists to preserve.
     */
    soleCopy: BeaconSoleCopyCandidate[];
    /**
     * Peer reports the server dropped to fit the frame budget, as of the last
     * GET. Non-zero ⇒ every sole-copy verdict is `'unknown'`.
     */
    truncated: number;
    /** True when `truncated > 0` — the reason sole-copy judgement is deferred. */
    soleCopyDeferred: boolean;
    /** Topics the last GET asked about. Local-only — see the header. */
    topicScope: string[];
    /** ISO-8601 time the board was captured, or null if no board has arrived. */
    boardAt: string | null;
    /** Age of the board in ms, or null if none. */
    boardAgeMs: number | null;
    /** True when there is no board, or it is older than {@link BEACON_BOARD_TTL_MS}. */
    stale: boolean;
    /**
     * ★ ADVISORY ONLY — never gate a write on this (§5.7a).
     */
    keyStaleAdvisory: BeaconKeyStaleAdvisory[];
}

/**
 * A board snapshot as captured by the beacon's own GET.
 *
 * Kept separate from `BeaconDiagnostics` because it is the RAW input: the
 * beacon records it on every successful GET, and diagnostics are computed from
 * it on demand. That split is what lets a read be free of I/O.
 */
export interface BeaconBoardSnapshot {
    reports: ProjectedBeaconReport[];
    /** Residual truncation after split-retry — see §7.1.2.1. */
    truncated: number;
    /** Topics the GET requested. */
    topicScope: string[];
    /** `Date.now()` at capture. */
    capturedAt: number;
}

/**
 * Per-topic replication shape, as far as diagnostics arithmetic cares.
 *
 * ★ WHY THIS EXISTS — the "boy who cried wolf" defect (2026-08-28).
 *
 * Both `behind` and `soleCopy` are computed by comparing a peer's position
 * against OUR OWN position in `node.vectors()`. That comparison is only
 * meaningful on a topic where we are *supposed* to hold the peer's entries —
 * i.e. a `full-sync` topic, where lagging behind is a real, closable gap.
 *
 * On a `subscribe-only` topic it is meaningless, and confidently wrong:
 * `fleet.status` and `session.*.transcript` are ring topics whose peer entries
 * arrive over a connection-scoped SUB and live in an in-memory slot map
 * (see `fleet-status-peer-view.ts` — "ring payloads are in-memory and
 * subscribe-only by contract"). They are NEVER written into our vectors. So
 * `mine` is permanently 0 for every peer writer, and the arithmetic reports:
 *
 *   - `behind` = the peer's ENTIRE LIFETIME append count, growing forever and
 *     never closing (observed live at 8,425 on rc.32, identical on all three
 *     machines because `maxBehind` just tracks the busiest peer); and
 *   - `sole-copy` for EVERY position we hold, because no peer ever reports the
 *     topic back into a place this comparison can see.
 *
 * A badge that is on permanently carries no information. Excluding non-
 * replicating topics is therefore not a threshold tweak or a display filter —
 * it removes a comparison whose inputs do not mean what the arithmetic assumes.
 * `mesh.<id>.events` is `full-sync` and stays in scope: its `behind` is a real
 * convergence number.
 */
export interface BeaconTopicReplication {
    /**
     * True when this node locally replicates peer entries for the topic — i.e.
     * `full-sync`. False for `subscribe-only`.
     */
    replicates: boolean;
    /**
     * Ring capacity, when the topic has ring retention. Bounds `unreplicated`:
     * a ring holds at most `size` entries, so claiming more than that could be
     * lost is arithmetically impossible regardless of what `localSeq` says.
     */
    ringSize?: number;
}

/**
 * Topic replication policy, keyed by topic name.
 *
 * Absent topic ⇒ treated as replicating. That default keeps this a targeted
 * exclusion rather than a silent whitelist: a caller that supplies no policy at
 * all (or a topic defined after the map was built) gets exactly the previous
 * behaviour, and only topics KNOWN to be subscribe-only are dropped.
 */
export type BeaconTopicPolicyMap = Readonly<Record<string, BeaconTopicReplication>>;

/**
 * Whether a topic's local-vs-peer position comparison is meaningful.
 *
 * Single decision point, so the "unknown ⇒ replicating" default cannot drift
 * between the `behind` loop and the `soleCopy` loop.
 */
function replicatesLocally(policy: BeaconTopicPolicyMap | undefined, topic: string): boolean {
    if (!policy) return true;
    const entry = policy[topic];
    return entry ? entry.replicates : true;
}

/**
 * Decide one sole-copy verdict.
 *
 * ★ THE discipline point for rule 1 in the header. Every verdict in this module
 * is produced here, so "truncated ⇒ unknown" is enforced in one place rather
 * than re-derived (and eventually forgotten) at each call site.
 *
 * Order matters: truncation is checked BEFORE the comparison, because a
 * truncated board can produce a perfectly confident-looking `localSeq >
 * bestPeerSeq` that is nonetheless wrong — the peer holding those entries is
 * exactly the one that got dropped.
 */
export function summarizeSoleCopy(args: {
    localSeq: number;
    bestPeerSeq: number | null;
    truncated: number;
    /** False when no board has been captured at all. */
    haveBoard: boolean;
}): { verdict: SoleCopyVerdict; unknownReason?: SoleCopyUnknownReason } {
    if (!args.haveBoard) return { verdict: 'unknown', unknownReason: 'no-board' };
    // ★ §7.1.2.1: the peer list is a subset of the fleet — defer, do not guess.
    if (args.truncated > 0) return { verdict: 'unknown', unknownReason: 'truncated' };
    if (args.bestPeerSeq === null) {
        // Board present, complete, and no peer reported this topic at all. That
        // IS the sole-copy signal: nobody else carries the topic.
        return { verdict: args.localSeq > 0 ? 'sole-copy' : 'replicated' };
    }
    return { verdict: args.bestPeerSeq < args.localSeq ? 'sole-copy' : 'replicated' };
}

/**
 * Bound an `unreplicated` count by the topic's ring capacity.
 *
 * `localSeq` is a monotonic sequence, not a live entry count: on a ring topic
 * the log holds at most `size` entries and older ones are already evicted. So
 * `localSeq - bestPeerSeq` can name a number of entries this node does not
 * actually still hold, and "12,000 entries exist only here" is impossible when
 * the ring is 50. Capping keeps the figure to what could genuinely be lost.
 *
 * Full-retention topics pass through unchanged — there the subtraction is exact.
 */
function capUnreplicated(raw: number, policy: BeaconTopicReplication | undefined): number {
    if (raw <= 0) return 0;
    const ring = policy?.ringSize;
    if (typeof ring !== 'number' || !Number.isFinite(ring) || ring <= 0) return raw;
    return Math.min(raw, ring);
}

/** Read a writer entry's effective sequence — retired entries seal at `finalSeq`. */
function writerSeq(entry: unknown): number | null {
    if (!entry || typeof entry !== 'object') return null;
    const w = entry as Record<string, unknown>;
    const raw = w.retired === true ? w.finalSeq : w.contig;
    return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
}

/**
 * Compute diagnostics from a board snapshot plus this node's own vectors.
 *
 * Pure — no node handle, no I/O — so the arithmetic is testable against
 * hand-built boards without opening a database. `computeBeaconDiagnostics` is
 * the whole feature; `beaconDiagnostics()` below is just the wiring that finds
 * the inputs.
 */
export function computeBeaconDiagnostics(args: {
    node: string;
    localVectors: Readonly<Record<string, { writers?: Record<string, unknown> }>>;
    board: BeaconBoardSnapshot | null;
    now?: number;
    /** ★ Advisory only (§5.7a); never a correctness gate. */
    keyStaleAdvisory?: BeaconKeyStaleAdvisory[];
    /**
     * Per-topic replication shape. Topics that do NOT replicate peer entries
     * locally are excluded from both `behind` and `soleCopy` — see
     * {@link BeaconTopicReplication} for why that is a correctness fix and not
     * a display filter. Omitted ⇒ every topic treated as replicating (previous
     * behaviour).
     */
    topicPolicy?: BeaconTopicPolicyMap;
}): BeaconDiagnostics {
    const now = args.now ?? Date.now();
    const board = args.board;
    const reports = board?.reports ?? [];
    const truncated = board?.truncated ?? 0;
    const haveBoard = board !== null;

    // ── Per-peer lag ────────────────────────────────────────────────────────
    // Compared against THIS node's positions, which is what makes the number
    // mean "how far behind am I" rather than "how far apart is the fleet".
    const peers: BeaconPeerDiagnostics[] = [];
    for (const report of reports) {
        // A peer's own report of itself is not a peer. Excluding it here (rather
        // than at capture) keeps the board a faithful record of what the server
        // returned.
        if (report.node === args.node) continue;

        const topics: BeaconPeerTopicLag[] = [];
        let worst = 0;
        for (const [topic, vec] of Object.entries(report.vectors ?? {})) {
            // ★ A subscribe-only topic's peer entries never land in our
            // vectors, so `mine` is structurally 0 and this lag would be the
            // peer's whole history. Not a gap — a category error.
            if (!replicatesLocally(args.topicPolicy, topic)) continue;
            let topicBehind = 0;
            for (const [writer, entry] of Object.entries(vec?.writers ?? {})) {
                const theirs = writerSeq(entry);
                if (theirs === null) continue;
                const mine = writerSeq(args.localVectors[topic]?.writers?.[writer]) ?? 0;
                const lag = theirs - mine;
                if (lag > 0) topicBehind += lag;
            }
            if (topicBehind > 0) {
                topics.push({ node: report.node, topic, behind: topicBehind });
                if (topicBehind > worst) worst = topicBehind;
            }
        }

        const seenAt = Date.parse(report.at);
        const lastSeenAgeMs = Number.isNaN(seenAt) ? 0 : Math.max(0, now - seenAt);
        peers.push({
            node: report.node,
            behind: worst,
            topics: topics.sort((a, b) => b.behind - a.behind),
            lastSeen: report.at,
            lastSeenAgeMs,
        });
    }
    peers.sort((a, b) => b.behind - a.behind || a.node.localeCompare(b.node));

    // ── Sole-copy candidates ────────────────────────────────────────────────
    // Walk OUR positions and ask whether anyone confirmed them. The inverse
    // (walk peers, look for gaps) would answer a different question — what the
    // fleet is missing collectively, not what would be lost if this machine died.
    const soleCopy: BeaconSoleCopyCandidate[] = [];
    for (const [topic, vec] of Object.entries(args.localVectors)) {
        // ★ Same exclusion as the lag loop. On a subscribe-only topic no peer
        // report can ever confirm our position, so `bestPeerSeq` is always null
        // and `summarizeSoleCopy` returns 'sole-copy' for EVERY entry we hold —
        // a permanent, content-free alarm.
        if (!replicatesLocally(args.topicPolicy, topic)) continue;
        for (const [writer, entry] of Object.entries(vec?.writers ?? {})) {
            const localSeq = writerSeq(entry);
            if (localSeq === null || localSeq <= 0) continue;

            let bestPeerSeq: number | null = null;
            for (const report of reports) {
                if (report.node === args.node) continue;
                const theirs = writerSeq(report.vectors?.[topic]?.writers?.[writer]);
                if (theirs === null) continue;
                if (bestPeerSeq === null || theirs > bestPeerSeq) bestPeerSeq = theirs;
            }

            const { verdict, unknownReason } = summarizeSoleCopy({
                localSeq,
                bestPeerSeq,
                truncated,
                haveBoard,
            });
            // `'replicated'` is the uninteresting majority — carrying every
            // caught-up position would make this list grow with the fleet and
            // bury the two verdicts a reader acts on.
            if (verdict === 'replicated') continue;

            soleCopy.push({
                topic,
                writer,
                localSeq,
                bestPeerSeq,
                unreplicated:
                    verdict === 'sole-copy'
                        ? capUnreplicated(localSeq - (bestPeerSeq ?? 0), args.topicPolicy?.[topic])
                        : 0,
                verdict,
                ...(unknownReason ? { unknownReason } : {}),
            });
        }
    }
    soleCopy.sort((a, b) => b.unreplicated - a.unreplicated || a.topic.localeCompare(b.topic));

    const boardAgeMs = board ? Math.max(0, now - board.capturedAt) : null;

    return {
        node: args.node,
        peers,
        maxBehind: peers.reduce((max, p) => (p.behind > max ? p.behind : max), 0),
        soleCopy,
        truncated,
        soleCopyDeferred: truncated > 0,
        topicScope: board?.topicScope ?? [],
        boardAt: board ? new Date(board.capturedAt).toISOString() : null,
        boardAgeMs,
        stale: boardAgeMs === null || boardAgeMs > BEACON_BOARD_TTL_MS,
        // ★ Advisory only — see BeaconKeyStaleAdvisory.
        keyStaleAdvisory: args.keyStaleAdvisory ?? [],
    };
}

/**
 * Read `staleness(topic).keyStale` for a set of (topic, key) pairs.
 *
 * ★ ADVISORY ONLY (§5.7a). Callers pass the hash keys admitted from peer
 * reports. The upstream reader chooses the raw maximum `seq` across writers,
 * not the producer's total order, so the result must never gate correctness.
 */
export function readKeyStaleAdvisory(
    handle: Pick<SeqscribeNodeHandle, 'node'>,
    pairs: readonly { topic: string; key: string }[],
): BeaconKeyStaleAdvisory[] {
    const out: BeaconKeyStaleAdvisory[] = [];
    for (const { topic, key } of pairs) {
        try {
            const stale = handle.node.staleness(topic, key);
            if (!stale?.keyStale) continue;
            out.push({
                topic,
                key,
                latestKnown: stale.keyStale.latestKnown,
                haveLocally: stale.keyStale.haveLocally === true,
            });
        } catch {
            // An undefined topic (or a library that refuses the query) is not a
            // diagnostics failure — this whole path is advisory.
        }
    }
    return out;
}

/**
 * Project the in-process diagnostics onto the P2P wire shape.
 *
 * ★ THE ONE JOB: strip the ELAPSED-TIME fields (`boardAgeMs`, `lastSeenAgeMs`,
 * `stale`) and keep only stable instants. Every status frame is deduped by
 * hashing the payload minus `timestamp`, so a field that is recomputed against
 * `Date.now()` on each report makes every frame unique — which would defeat the
 * dedup and convert an idle daemon into a constant transmitter. §7.1.2's whole
 * premise is that Beacon does NOT do that. The consumer derives age from
 * `boardAt` / `lastSeen` at render time, which is both stable on the wire and
 * more correct at the point of display.
 *
 * This is an explicit field-by-field ALLOW-LIST, not a spread-and-delete: the
 * same discipline as every other boundary projection in the codebase. A field
 * added to `BeaconDiagnostics` does not reach the wire until someone lists it
 * here and asks whether it is stable.
 */
export function toBeaconDiagnosticsSummary(d: BeaconDiagnostics): BeaconDiagnosticsSummary {
    return {
        node: d.node,
        peers: d.peers.map((p) => ({
            node: p.node,
            behind: p.behind,
            topics: p.topics.map((t) => ({ node: t.node, topic: t.topic, behind: t.behind })),
            lastSeen: p.lastSeen,
            // `lastSeenAgeMs` intentionally dropped — see the header.
        })),
        maxBehind: d.maxBehind,
        soleCopy: d.soleCopy.map((s) => ({
            topic: s.topic,
            writer: s.writer,
            localSeq: s.localSeq,
            bestPeerSeq: s.bestPeerSeq,
            unreplicated: s.unreplicated,
            verdict: s.verdict,
            ...(s.unknownReason ? { unknownReason: s.unknownReason } : {}),
        })),
        truncated: d.truncated,
        soleCopyDeferred: d.soleCopyDeferred,
        topicScope: [...d.topicScope],
        boardAt: d.boardAt,
        // `boardAgeMs` and `stale` intentionally dropped — both are derived
        // from Date.now() and would tick on every report.
        keyStaleAdvisory: d.keyStaleAdvisory.map((k) => ({
            topic: k.topic,
            key: k.key,
            latestKnown: k.latestKnown,
            haveLocally: k.haveLocally,
        })),
    };
}
